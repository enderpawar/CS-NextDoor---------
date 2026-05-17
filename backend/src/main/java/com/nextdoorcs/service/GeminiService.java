package com.nextdoorcs.service;

import com.nextdoorcs.exception.DiagnosisException;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.RestTemplate;

import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;

@Service
@RequiredArgsConstructor
public class GeminiService {

    @Value("${gemini.api.key}")
    private String apiKey;

    // gemini-3.1-pro-preview 접근 가능 시 application.properties에서 변경
    @Value("${gemini.model:gemini-2.0-flash}")
    private String model;

    private static final String GEMINI_BASE_URL =
        "https://generativelanguage.googleapis.com/v1beta/models/";

    private final RestTemplate restTemplate;

    /**
     * 이미지 단독 진단 (Phase 1 기본)
     */
    public String diagnoseImage(String base64Image, String symptom) {
        List<Map<String, Object>> parts = List.of(
            Map.of("text", buildHardwareSystemPrompt(symptom, null)),
            Map.of("inline_data", Map.of(
                "mime_type", "image/jpeg",
                "data", base64Image
            ))
        );
        return callGemini(parts);
    }

    /**
     * 이미지 + 오디오 멀티모달 진단 (Phase 8 확장)
     * audioMimeType: 실제 녹음 포맷 전달 필수 ("audio/webm" | "audio/mp4")
     */
    public String diagnoseMultimodal(
            String base64Image,
            byte[] audioBytes,
            String audioMimeType,
            String symptom,
            String biosType) {

        List<Map<String, Object>> parts = new ArrayList<>();
        parts.add(Map.of("text", buildHardwareSystemPrompt(symptom, biosType)));

        if (base64Image != null && !base64Image.isBlank()) {
            parts.add(Map.of("inline_data", Map.of("mime_type", "image/jpeg", "data", base64Image)));
        }

        if (audioBytes != null) {
            String mimeType = (audioMimeType != null && !audioMimeType.isBlank())
                ? audioMimeType
                : "audio/webm";  // iOS mp4는 클라이언트가 명시 전달 필요
            parts.add(Map.of("inline_data", Map.of(
                "mime_type", mimeType,
                "data", Base64.getEncoder().encodeToString(audioBytes)
            )));
        }
        return callGemini(parts);
    }

    /**
     * 증상 + 시스템 스냅샷 → 가설 A/B/C 생성 (SW 진단 전용)
     */
    public String generateHypotheses(String symptom, String systemSnapshotJson, String base64Image) {
        List<Map<String, Object>> parts = new ArrayList<>();
        parts.add(Map.of("text", buildHypothesisPrompt(symptom, systemSnapshotJson)));

        if (base64Image != null && !base64Image.isBlank()) {
            parts.add(Map.of("inline_data", Map.of(
                "mime_type", "image/jpeg",
                "data", base64Image
            )));
        }
        return callGemini(parts);
    }

    // ── Private helpers ────────────────────────────────────────────────────────

    private String callGemini(List<Map<String, Object>> parts) {
        return callGemini(parts, null);
    }

    private String callGemini(List<Map<String, Object>> parts, Map<String, Object> generationConfig) {
        if (apiKey == null || apiKey.isBlank()) {
            throw new DiagnosisException("Gemini API 키가 설정되지 않았어요. 백엔드 실행 환경에 GEMINI_API_KEY를 넣어주세요.");
        }

        Map<String, Object> requestBody = generationConfig == null
            ? Map.of("contents", List.of(Map.of("parts", parts)))
            : Map.of(
                "contents", List.of(Map.of("parts", parts)),
                "generationConfig", generationConfig
            );
        String url = GEMINI_BASE_URL + model + ":generateContent?key=" + apiKey;

        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> response = restTemplate.postForObject(url, requestBody, Map.class);
            return extractText(response);
        } catch (HttpStatusCodeException e) {
            int status = e.getStatusCode().value();
            if (status == 403) {
                throw new DiagnosisException("Gemini API 키 또는 모델 접근 권한을 확인해주세요.", 500);
            }
            if (status == 404) {
                throw new DiagnosisException("Gemini 모델을 찾을 수 없어요. GEMINI_MODEL 설정을 확인해주세요.", 500);
            }
            throw new DiagnosisException("Gemini API 호출에 실패했어요. 상태 코드: " + status, 500);
        }
    }

    /**
     * Gemini 응답에서 텍스트 추출 — 모든 null/빈값 방어 처리
     */
    @SuppressWarnings("unchecked")
    private String extractText(Map<String, Object> response) {
        if (response == null)
            throw new DiagnosisException("Gemini 응답이 없어요. API 키를 확인해주세요.");

        // 오류 응답 확인
        if (response.containsKey("error")) {
            Map<String, Object> error = (Map<String, Object>) response.get("error");
            throw new DiagnosisException("Gemini 오류: " + error.get("message"));
        }

        var candidates = (List<Map<String, Object>>) response.get("candidates");
        if (candidates == null || candidates.isEmpty())
            throw new DiagnosisException("Gemini 응답에 candidates가 없어요.");

        var content = (Map<String, Object>) candidates.get(0).get("content");
        if (content == null)
            throw new DiagnosisException("Gemini 응답에 content가 없어요.");

        var parts = (List<Map<String, Object>>) content.get("parts");
        if (parts == null || parts.isEmpty())
            throw new DiagnosisException("Gemini 응답에 parts가 없어요.");

        Object text = parts.get(0).get("text");
        if (text == null)
            throw new DiagnosisException("Gemini 응답 텍스트가 비어 있어요.");

        return text.toString();
    }

    private String buildHardwareSystemPrompt(String symptom, String biosType) {
        String biosInfo = biosType != null ? "\nBIOS 제조사: " + biosType : "";
        return """
            당신은 '옆집 컴공생' AI입니다. PC 하드웨어 문제를 진단해주세요.
            말투: 친근한 공대생처럼, 존댓말 사용.
            전문 용어는 괄호로 설명해주세요.

            증상: %s%s

            다음 JSON 형식으로만 응답해주세요 (코드 블록 없이):
            {"cause":"[부품명]에 문제 있어요. 원인: ...","solution":"1. 첫 번째 조치\\n2. 두 번째 조치","confidence":0.85,"parts":["RAM"]}

            주의:
            - confidence는 0.0~1.0 숫자
            - parts는 ["RAM","GPU","MAINBOARD","PSU","STORAGE","CPU","COOLING"] 중 해당 항목
            - 수리기사 권장 조건: 납땜/전문장비/안전위험/confidence < 0.6
            """.formatted(symptom, biosInfo);
    }

    /**
     * SW 가설 확정: baseline + delta → 재현 성공 기반 확정 진단
     */
    public String confirmSoftwareDiagnosis(
            String hypothesisTitle,
            String baselineJson,
            String deltaJson,
            String symptom,
            String previousDiagnosisId) {

        String prevContext = (previousDiagnosisId != null && !previousDiagnosisId.isBlank())
            ? "\n\n이전 진단 ID: " + previousDiagnosisId + " (복합 원인 추가 분석 요청)"
            : "";

        String prompt = """
            당신은 '옆집 컴공생' AI입니다. 재현 테스트 결과를 바탕으로 SW 진단을 확정해주세요.
            말투: 친근한 공대생처럼, 존댓말 사용.

            증상: %s
            검증 중인 가설: %s
            베이스라인(재현 전): %s
            Delta(재현 후 변화량): %s%s

            다음 JSON 형식으로만 응답해주세요 (코드 블록 없이):
            {
              "diagnosisId": "UUID",
              "confirmedHypothesis": "확정된 가설 제목",
              "cause": "[프로세스/서비스]에 문제 있어요. 원인: ...",
              "solution": "1. 첫 번째 조치\\n2. 두 번째 조치\\n3. 세 번째 조치",
              "confidence": 0.85,
              "requiresRepairShop": false,
              "isComplex": false
            }

            주의:
            - confidence: 0.0~1.0, delta 변화량이 클수록 높게 설정
            - requiresRepairShop: confidence < 0.6 이거나 HW 문제 의심 시 true
            - isComplex: SW+HW 복합 원인 의심 시 true, "SW + HW 복합 원인 가능성 있음" 명시
            - 수리기사 권장: confidence < 0.6, 납땜/전문장비/안전위험 중 하나라도 해당 시
            """.formatted(symptom, hypothesisTitle, baselineJson, deltaJson, prevContext);

        return callGemini(List.of(Map.of("text", prompt)));
    }

    /**
     * 이벤트 로그 기반 패턴 제안: 재현 실패 시 유사 패턴 제안
     */
    public String suggestPatterns(String eventLogJson, String symptom) {
        String symptomContext = (symptom != null && !symptom.isBlank())
            ? "\n증상: " + symptom
            : "";

        String prompt = """
            당신은 '옆집 컴공생' AI입니다. Windows 이벤트 로그를 분석해 유사 패턴을 제안해주세요.
            말투: 친근한 공대생처럼, 존댓말 사용.
            %s

            이벤트 로그:
            %s

            이벤트 로그에서 에러/경고 패턴을 분석해 최대 3가지 유사 패턴을 제안해주세요.
            패턴이 없으면 빈 배열을 반환하세요.

            다음 JSON 형식으로만 응답해주세요 (코드 블록 없이):
            {
              "patterns": [
                {
                  "id": "p1",
                  "title": "패턴 제목",
                  "description": "패턴 설명 (증상과 연관성)",
                  "matchReason": "이벤트 로그에서 매칭된 근거",
                  "relevanceScore": 0.85
                }
              ],
              "summary": "패턴이 있으면 요약, 없으면 \\"간헐적 증상이라 지금 당장 파악이 어려워요\\""
            }
            """.formatted(symptomContext, eventLogJson);

        return callGemini(List.of(Map.of("text", prompt)));
    }

    /**
     * 라이브 가이드 모드 — 화면 이미지 + 프롬프트 → 안내 텍스트 (단순 텍스트 반환)
     */
    public String generateGuideResponse(String prompt, String frameBase64) {
        List<Map<String, Object>> parts = new ArrayList<>();
        parts.add(Map.of("text", prompt));
        if (frameBase64 != null && !frameBase64.isBlank()) {
            parts.add(Map.of("inline_data", Map.of(
                "mime_type", "image/jpeg",
                "data", frameBase64
            )));
        }
        return callGemini(parts, Map.of(
            "responseMimeType", "application/json",
            "temperature", 0.2
        ));
    }

    private String buildHypothesisPrompt(String symptom, String systemSnapshotJson) {
        String snapshotSection = systemSnapshotJson != null && !systemSnapshotJson.equals("null")
            ? "\n\n시스템 정보:\n" + systemSnapshotJson
            : "";
        return """
            당신은 '옆집 컴공생' AI입니다. 소프트웨어 문제를 진단하고 3가지 가설을 제시해주세요.
            말투: 친근한 공대생처럼, 존댓말 사용.

            증상: %s%s

            다음 JSON 형식으로만 응답해주세요 (코드 블록 없이):
            {
              "diagnosisId": "UUID",
              "hypotheses": [
                {
                  "id": "h1",
                  "title": "가설 제목",
                  "description": "상세 설명 (증상과 연관성)",
                  "priority": "A",
                  "confidence": 0.85,
                  "status": "pending"
                }
              ],
              "immediateAction": "지금 당장 해볼 수 있는 가장 쉬운 조치"
            }

            가설 우선순위 규칙:
            - A: 직접 시도 가능, 위험도 낮음 (재시작, 드라이버 업데이트, 설정 변경)
            - B: 중간 위험도 또는 시간 소요 (포맷, 하드웨어 교체)
            - C: 전문 개입 필요 (납땜, 부품 교체, 데이터 복구)
            반드시 A → B → C 순으로 정렬. confidence는 0.0~1.0.
            """.formatted(symptom, snapshotSection);
    }
}
