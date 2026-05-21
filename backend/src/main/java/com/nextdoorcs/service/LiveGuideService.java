package com.nextdoorcs.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.nextdoorcs.exception.DiagnosisException;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
public class LiveGuideService {

    private final GeminiService geminiService;
    private final ObjectMapper objectMapper;

    @Value("${gemini.api.key}")
    private String apiKey;

    @Value("${gemini.model:gemini-3.5-flash}")
    private String model;

    // 세션 저장소 — 15분 TTL, 인메모리 (Phase 10 이전)
    private final ConcurrentHashMap<String, GuideSession> sessions = new ConcurrentHashMap<>();

    private static final long SESSION_TTL_MS = 15 * 60 * 1000L;

    // ── 세션 생명주기 ──────────────────────────────────────────────────────────

    public String createSession(String context) {
        String sessionId = UUID.randomUUID().toString();
        sessions.put(sessionId, new GuideSession(sessionId, context, Instant.now()));
        return sessionId;
    }

    public void deleteSession(String sessionId) {
        sessions.remove(sessionId);
    }

    // ── 프레임 처리 + SSE 스트리밍 ────────────────────────────────────────────

    /**
     * SseEmitter 타임아웃 60초.
     * Gemini 호출은 CompletableFuture.runAsync() — 컨트롤러 스레드 블로킹 방지.
     */
    public SseEmitter processFrame(
            String sessionId,
            String frameBase64,
            List<Map<String, String>> history,
            String cvSummary,
            List<Map<String, Object>> ocrRegions,
            String userQuestion,
            String taskGoal) {

        GuideSession session = sessions.get(sessionId);
        if (session == null) throw new DiagnosisException("가이드 세션을 찾을 수 없어요: " + sessionId);

        SseEmitter emitter = new SseEmitter(60_000L);

        CompletableFuture.runAsync(() -> {
            try {
                String prompt = buildGuidePrompt(session.context(), history, cvSummary, ocrRegions, userQuestion, taskGoal);
                GuideModelResponse guideResponse = parseGuideResponse(
                    geminiService.generateGuideResponse(prompt, frameBase64),
                    ocrRegions
                );
                // Gemini가 overlay=null로 답해도 message에 OCR 후보 텍스트가 명시되면 자동 매칭
                guideResponse = autoOverlayFromMessage(guideResponse, ocrRegions);
                guideResponse = normalizeOverlayInstruction(guideResponse);

                emitter.send(SseEmitter.event().data(guideResponse.message()));

                if (guideResponse.overlay() != null) {
                    emitter.send(SseEmitter.event()
                        .name("overlay")
                        .data(objectMapper.writeValueAsString(guideResponse.overlay())));
                }
                emitter.send(SseEmitter.event().data("[DONE]"));
                emitter.complete();
            } catch (Exception e) {
                try {
                    emitter.send(SseEmitter.event().data("오류가 발생했어요: " + e.getMessage()));
                    emitter.send(SseEmitter.event().data("[DONE]"));
                    emitter.complete();
                } catch (IOException ex) {
                    emitter.completeWithError(ex);
                }
            }
        });

        return emitter;
    }

    // ── 만료 세션 정리 (@Scheduled 15분 주기) ─────────────────────────────────

    @Scheduled(fixedDelay = 5 * 60 * 1000L)
    public void cleanupExpiredSessions() {
        Instant cutoff = Instant.now().minusMillis(SESSION_TTL_MS);
        List<String> expired = sessions.entrySet().stream()
            .filter(e -> e.getValue().createdAt().isBefore(cutoff))
            .map(Map.Entry::getKey)
            .collect(Collectors.toList());
        expired.forEach(sessions::remove);
    }

    // ── 프롬프트 생성 ─────────────────────────────────────────────────────────

    private String buildGuidePrompt(
            String context,
            List<Map<String, String>> history,
            String cvSummary,
            List<Map<String, Object>> ocrRegions,
            String userQuestion,
            String taskGoal) {
        String historyText = (history == null || history.isEmpty())
            ? ""
            : "\n\n이전 대화:\n" + history.stream()
                .map(m -> m.getOrDefault("role", "user") + ": " + m.getOrDefault("text", ""))
                .collect(Collectors.joining("\n"));

        String cvText = (cvSummary == null || cvSummary.isBlank())
            ? ""
            : "\n\nOpenCV 전처리 요약:\n" + cvSummary;
        if (cvSummary != null && (cvSummary.contains("captureSource=clip") || cvSummary.contains("captureSource=galleryVideo"))) {
            cvText = "\n\n짧은 영상 분석 요약(원본 영상/오디오는 업로드되지 않았고, 대표 프레임 1장과 클라이언트가 추출한 깜빡임·장면 변화·소리 특징만 전달됨):\n" + cvSummary;
        }

        String ocrText = buildOcrPromptSection(ocrRegions);

        String questionText = (userQuestion == null || userQuestion.isBlank())
            ? ""
            : "\n\n사용자 질문:\n" + userQuestion.trim();

        String goalText = (taskGoal == null || taskGoal.isBlank())
            ? ""
            : "\n\n세션 목표 작업:\n" + taskGoal.trim();

        String workflowText = "";
        if (cvSummary != null && cvSummary.contains("guidePhase=followup")) {
            workflowText = """

            현재 요청은 새 문제 분석이 아니라 같은 세션의 후속 단계입니다.
            이전에 안내한 조치가 해결되지 않았다는 전제로, 같은 조치를 반복하지 말고 다음으로 확인할 1단계만 제시하세요.
            이전 화면 설명은 필요한 경우 한 줄로만 갱신하고, 답변의 중심은 다음 조치와 확인 질문에 두세요.
            """;
        }

        String contextDesc = switch (context) {
            case "GENERAL"          -> "사용자가 상황을 특정하지 못한 PC 문제. 카메라 화면 단서로 문제 유형 분류부터 시작";
            case "NO_BOOT"          -> "PC 부팅 불가 또는 화면 표시 실패";
            case "SLOW_PC"          -> "PC 성능 저하, 멈춤, 발열, 팬 소음";
            case "APP_NOT_OPENING"  -> "프로그램 실행 불가, 오류 팝업, 설치 실패";
            case "NETWORK_ISSUE"    -> "인터넷, Wi-Fi, 랜선, DNS, 공유기 문제";
            case "BLUE_SCREEN"      -> "블루스크린, 중지 코드, 자동 재부팅";
            case "BIOS_BOOT"        -> "BIOS 진입, 부팅 순서, Secure Boot, Windows 설치";
            case "HW_REPAIR_RAM"    -> "PC 케이스 분해 후 RAM 메모리 분리·접점 청소·재장착";
            case "HW_REPAIR_GPU"    -> "PC 케이스 분해 후 그래픽카드(GPU) 분리·전원 케이블·재장착";
            default                 -> context;
        };

        boolean isHwRepair = "HW_REPAIR_RAM".equals(context) || "HW_REPAIR_GPU".equals(context);

        boolean hasGoal = taskGoal != null && !taskGoal.isBlank();
        String modeBlock = hasGoal
            ? "모드: 목표-우선. ★목표: " + taskGoal.trim() + " (보조 힌트: " + contextDesc + "). 진단·분류로 빠지지 말고 항상 목표 달성의 다음 1단계만 안내."
            : isHwRepair
                ? "모드: 하드웨어 조치. 증상: " + contextDesc + ". 카메라가 비춘 부품 위치·상태를 보고 물리 조치 다음 1단계만 안내."
                : "모드: 진단. 증상: " + contextDesc + ". 화면·오류·상태를 보고 다음 1~2단계 안내.";

        String hwSafetyBlock = isHwRepair ? """

            하드웨어 조치 안전 원칙 (필수):
            - 전제: 사용자는 이미 PC 전원을 차단했고 정전기 방전을 마쳤다고 가정한다. 매 응답마다 반복 경고는 하지 않는다.
            - 단, 카메라에 전원 LED·팬 회전이 보이거나 메인 케이블이 연결된 상태면 한 문장으로 "전원 코드 분리부터 다시 해주세요" 안내한다.
            - 부품 핀·접점에 손가락·금속·물을 직접 닿게 하는 표현 금지. 지우개는 "마른 지우개로 가볍게" 정도만 허용.
            - 납땜·메인보드 부품 교체 등 사용자가 직접 못하는 조치는 권장하지 않고 "수리 기사 상담"으로 안내.
            """ : "";

        String overlayRulesBlock = isHwRepair ? """
            overlay 지정 규칙 (HW 조치 모드):
            - overlay는 지금 사용자가 실제로 손을 대야 할 부품/슬롯/케이블 1개만 지정한다.
            - 예: RAM 슬롯 1개, RAM 양쪽 클립 1쌍, GPU PCIe 슬롯 잠금 레버, GPU 보조전원 8핀 커넥터.
            - bbox는 원본 이미지를 1000x1000으로 정규화한 좌표(normalized1000)로, 부품 윤곽만 타이트하게 감싼다.
            - 메인보드 전체나 케이스 전체처럼 큰 영역은 지정하지 않는다.
            - OCR 후보는 무시한다(BIOS 화면이 아님). targetId 없이 bbox만 보내면 된다.
            - mode 필드는 반드시 "action"으로 보낸다. label은 "여기를 조치하세요!" 또는 "여기를 분리하세요!" 등 동작 동사를 쓴다.
            - overlay를 지정하면 message에서도 해당 부품을 자연어로 한 번 언급한다(예: "왼쪽 첫 번째 RAM 슬롯").

            JSON으로만 응답(코드블록·마크다운 금지).
            예시 1 (부품 안 보임): {"message":"케이스를 좀 더 열어서 메인보드의 검은색 긴 슬롯들이 보이도록 비춰주세요.","overlay":null}
            예시 2 (RAM 슬롯 지정): {"message":"왼쪽 첫 번째 RAM 슬롯이에요. 양쪽 흰색 클립을 바깥쪽으로 눌러서 메모리를 빼주세요.","overlay":{"label":"여기를 조치하세요!","reason":"RAM 슬롯 양쪽 클립","mode":"action","bbox":{"x":220,"y":340,"w":520,"h":120,"unit":"normalized1000"}}}
            """ : """
            overlay 지정 규칙 (중요):
            - overlay는 지금 사용자가 실제로 눌러야 하는 버튼/메뉴 행 1개만 지정한다.
            - 부팅 순서 변경 목표라면 보통 "Boot Option #1" 또는 첫 번째 Boot Priority 행을 지정한다. BIOS 이미지 전체나 큰 패널을 지정하지 않는다.
            - bbox는 원본 이미지 전체를 1000x1000으로 정규화한 좌표(normalized1000)로, 실제 클릭할 텍스트 행/버튼만 감싼다.
            - OCR 후보가 있으면 targetId도 후보 id 중 하나로 고른다. OCR이 부정확하면 targetId 없이 bbox만 제공해도 된다.
            - mode 필드는 기본값 "click"으로 둔다(생략해도 됨).
            - overlay를 지정하면 message에서도 해당 항목의 화면상 텍스트(예: "Boot Option #1")를 자연어로 한 번 언급한다.

            JSON으로만 응답(코드블록·마크다운 금지).
            예시 1 (후보 없음·전부 무관): {"message":"2~4문장 한국어","overlay":null}
            예시 2 (항목 지정): {"message":"Boot Option #1을 선택해서 USB로 부팅 순서를 바꿔주세요.","overlay":{"targetId":"ocr-line-3","label":"여기를 클릭하세요!","reason":"부팅 순서 1순위 항목","mode":"click","bbox":{"x":220,"y":710,"w":360,"h":42,"unit":"normalized1000"}}}
            """;

        return """
            당신은 '옆집 컴공생' AI. 친근한 공대생 존댓말. 한 번에 1단계.
            %s

            매 응답 구성: ①현재 화면이 목표/증상 경로 어디인지 한 줄. ②다음 1단계 조작(키/메뉴/클릭). ③"해본 뒤 화면 바뀌면 다시 비춰주세요" 류 확인 질문.

            금지·주의:
            - 사용자가 결과 말하기 전 "해결됐어요/완료됐어요" 단정 금지.
            - "[완료]" 태그 출력 금지. 종료는 사용자가 결정.
            - 한 응답에 여러 단계 몰아 금지.
            - 화면이 목표와 무관하면 그 화면에서 목표 화면으로 들어가는 진입 1단계만.
            - 데이터 손실·되돌리기 어려운 조작(포맷/초기화/Secure Boot 해제/파티션 삭제/F10 저장)은 직전 한 문장 경고 후 확인 유도.
            - previousActionResult=tried면 바뀐 단서 짚고 다음 단계. =unresolved면 같은 조치 반복 금지, 다른 경로 1개.
            - OpenCV 요약은 화면 품질·정면화 판단 보조용.
            - 사용자 질문은 목표와 함께 해석해 1단계 안내에 연결.
            %s
            %s%s%s%s%s%s%s
            """.formatted(modeBlock, hwSafetyBlock, overlayRulesBlock, historyText, cvText, ocrText, goalText, questionText, workflowText);
    }

    private String buildOcrPromptSection(List<Map<String, Object>> ocrRegions) {
        if (ocrRegions == null || ocrRegions.isEmpty()) return "";
        List<Map<String, Object>> compact = ocrRegions.stream()
            .limit(60)
            .map(region -> Map.of(
                "id", Objects.toString(region.get("id"), ""),
                "text", Objects.toString(region.get("text"), ""),
                "confidence", region.get("confidence") != null ? region.get("confidence") : 0,
                "bbox", region.get("bbox") != null ? region.get("bbox") : Map.of()
            ))
            .collect(Collectors.toList());
        try {
            return "\n\nOCR 후보 영역(JSON, 원본 프레임 좌표):\n" + objectMapper.writeValueAsString(compact);
        } catch (Exception e) {
            return "";
        }
    }

    private GuideModelResponse parseGuideResponse(String raw, List<Map<String, Object>> ocrRegions) {
        String cleaned = raw == null ? "" : raw.trim();
        if (cleaned.contains("```")) {
            cleaned = cleaned.replaceAll("```[a-zA-Z]*\\n?", "").replaceAll("```", "").trim();
        }

        int jsonStart = cleaned.indexOf('{');
        int jsonEnd = cleaned.lastIndexOf('}');
        if (jsonStart >= 0 && jsonEnd > jsonStart) {
            String json = cleaned.substring(jsonStart, jsonEnd + 1);
            try {
                JsonNode root = objectMapper.readTree(json);
                String message = root.path("message").asText(cleaned);
                GuideOverlay overlay = null;
                JsonNode overlayNode = root.path("overlay");
                if (overlayNode.isObject()) {
                    String targetId = overlayNode.path("targetId").asText("");
                    String label = overlayNode.path("label").asText("여기를 선택");
                    String reason = overlayNode.path("reason").asText(null);
                    String modeRaw = overlayNode.path("mode").asText("click");
                    String mode = "action".equals(modeRaw) ? "action" : "click";
                    Map<String, Object> bbox = parseOverlayBbox(overlayNode.path("bbox"));
                    if (!targetId.isBlank() && isKnownOcrTarget(targetId, ocrRegions)) {
                        overlay = new GuideOverlay(targetId, label, reason, mode, bbox);
                    } else if (bbox != null) {
                        overlay = new GuideOverlay(null, label, reason, mode, bbox);
                    }
                }
                return new GuideModelResponse(message, overlay);
            } catch (Exception ignored) {
                // 기존 텍스트 응답과 모델 형식 이탈은 아래 폴백으로 처리
            }
        }

        return new GuideModelResponse(cleaned, null);
    }

    /**
     * Gemini overlay 누락 시 텍스트 매칭으로 OCR 후보를 자동 선택.
     *
     * 호출 조건: response.overlay() == null AND ocrRegions 존재.
     * 우선순위:
     *   1) message에 작은따옴표/큰따옴표/백틱으로 감싸진 텍스트가 OCR 후보와 일치 (정확 매칭)
     *   2) message에 OCR 후보 텍스트가 그대로 포함 (substring, 길이 ≥ 4)
     *   3) 매칭이 여러 개면 가장 긴 후보 텍스트를 선택 (구체적인 메뉴명일 가능성 높음)
     */
    private GuideModelResponse autoOverlayFromMessage(
            GuideModelResponse response,
            List<Map<String, Object>> ocrRegions) {

        if (response.overlay() != null) return response;
        if (ocrRegions == null || ocrRegions.isEmpty()) return response;
        String message = response.message();
        if (message == null || message.isBlank()) return response;

        // 1) 따옴표/백틱으로 감싸진 토큰 추출 — Gemini가 UI 항목 언급 시 자주 사용
        java.util.regex.Matcher quoted = java.util.regex.Pattern
            .compile("['‘’\"“”`]([^'‘’\"“”`]{2,40})['‘’\"“”`]")
            .matcher(message);
        java.util.Set<String> quotedTokens = new java.util.LinkedHashSet<>();
        while (quoted.find()) quotedTokens.add(quoted.group(1).trim());

        Map<String, Object> bestMatch = null;
        int bestScore = 0;

        for (Map<String, Object> region : ocrRegions) {
            String text = Objects.toString(region.get("text"), "").trim();
            if (text.length() < 4) continue;
            String norm = text.toLowerCase(java.util.Locale.ROOT);
            int score = 0;

            // 우선순위 1: 따옴표 안 텍스트와 정확/부분 일치
            for (String token : quotedTokens) {
                String tokenNorm = token.toLowerCase(java.util.Locale.ROOT);
                if (tokenNorm.equals(norm))                score = Math.max(score, 1000 + text.length());
                else if (tokenNorm.contains(norm))         score = Math.max(score, 600 + text.length());
                else if (norm.contains(tokenNorm) && tokenNorm.length() >= 4)
                                                           score = Math.max(score, 500 + tokenNorm.length());
            }

            // 우선순위 2: message에 그대로 등장 (substring)
            if (score == 0 && message.toLowerCase(java.util.Locale.ROOT).contains(norm)) {
                score = 100 + text.length();
            }

            if (score > bestScore) {
                bestScore = score;
                bestMatch = region;
            }
        }

        if (bestMatch == null) return response;

        String targetId = Objects.toString(bestMatch.get("id"), "");
        String text = Objects.toString(bestMatch.get("text"), "");
        if (targetId.isBlank()) return response;

        GuideOverlay overlay = new GuideOverlay(
            targetId,
            "여기를 클릭하세요!",
            "메시지에서 언급한 '" + text + "' 항목 위치",
            "click",
            null
        );
        return new GuideModelResponse(response.message(), overlay);
    }

    private GuideModelResponse normalizeOverlayInstruction(GuideModelResponse response) {
        if (response.overlay() == null) return response;

        // mode='action'이면 물리 조치 라벨, 그 외(click)는 클릭 라벨로 강제 정규화
        boolean isAction = "action".equals(response.overlay().mode());
        String forcedLabel = isAction ? "여기를 조치하세요!" : "여기를 클릭하세요!";

        GuideOverlay overlay = new GuideOverlay(
            response.overlay().targetId(),
            forcedLabel,
            response.overlay().reason(),
            isAction ? "action" : "click",
            response.overlay().bbox()
        );

        String message = response.message() == null ? "" : response.message().trim();
        if (message.isBlank()) {
            message = "표시된 항목을 선택한 뒤 화면이 바뀌면 다시 비춰주세요.";
        }

        return new GuideModelResponse(message, overlay);
    }

    private boolean isKnownOcrTarget(String targetId, List<Map<String, Object>> ocrRegions) {
        if (ocrRegions == null || ocrRegions.isEmpty()) return false;
        return ocrRegions.stream()
            .map(region -> Objects.toString(region.get("id"), ""))
            .anyMatch(targetId::equals);
    }

    private Map<String, Object> parseOverlayBbox(JsonNode bboxNode) {
        if (bboxNode == null || !bboxNode.isObject()) return null;
        JsonNode xNode = bboxNode.path("x");
        JsonNode yNode = bboxNode.path("y");
        JsonNode wNode = bboxNode.path("w");
        JsonNode hNode = bboxNode.path("h");
        if (!xNode.isNumber() || !yNode.isNumber() || !wNode.isNumber() || !hNode.isNumber()) return null;

        // 프롬프트가 normalized1000만 허용 — 다른 unit이 오면 좌표계가 어긋나 AR 박스가 잘못 위치.
        // pixel/normalized01을 normalized1000으로 변환하는 대신 거부 → 프론트는 OCR fallback으로 전환.
        String unit = bboxNode.path("unit").asText("normalized1000");
        if (!"normalized1000".equals(unit)) return null;

        double x = clamp(xNode.asDouble(), 0, 1000);
        double y = clamp(yNode.asDouble(), 0, 1000);
        double w = clamp(wNode.asDouble(), 1, 1000);
        double h = clamp(hNode.asDouble(), 1, 1000);

        return Map.of("x", x, "y", y, "w", w, "h", h, "unit", unit);
    }

    private double clamp(double value, double min, double max) {
        return Math.max(min, Math.min(max, value));
    }

    // ── 내부 레코드 ───────────────────────────────────────────────────────────

    private record GuideSession(String sessionId, String context, Instant createdAt) {}
    private record GuideModelResponse(String message, GuideOverlay overlay) {}
    // mode: "click" (화면 UI 클릭) | "action" (물리 부품 조치). 기본값 "click".
    private record GuideOverlay(String targetId, String label, String reason, String mode, Map<String, Object> bbox) {}
}
