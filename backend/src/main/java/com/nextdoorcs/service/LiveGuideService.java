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

    @Value("${gemini.model:gemini-2.0-flash}")
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

                // 텍스트를 단어 단위로 청크 분할하여 스트리밍 효과
                String[] words = guideResponse.message().split("(?<=\\s)");
                for (String word : words) {
                    try {
                        emitter.send(SseEmitter.event().data(word));
                        Thread.sleep(20);  // 타이핑 효과
                    } catch (IOException e) {
                        emitter.completeWithError(e);
                        return;
                    }
                }

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
            default                 -> context;
        };

        return """
            당신은 '옆집 컴공생' AI입니다. 사용자가 PWA 카메라로 비추는 PC 화면, 오류 메시지, 장치 상태를 보고 단계별로 진단해주세요.
            말투: 친근한 공대생처럼, 존댓말 사용. 한 번에 1~2 단계만 안내.

            현재 진단 증상: %s

            화면을 분석하고:
            1. 현재 보이는 화면/오류/상태를 한 줄로 확인
            2. PWA 환경에서도 사용자가 직접 할 수 있는 확인 또는 조작 1~2단계 안내
            3. 사용자가 아직 조치 결과를 말하지 않았다면 절대 "해결되었습니다", "완료되었습니다"처럼 단정하지 말 것
            4. 응답의 정상 흐름은 반드시 "현재 상태 확인 → 조치사항 1~2개 제안 → 조치 후 확인 질문" 순서로 구성
            5. 마지막 문장은 가능하면 "조치해보신 뒤 증상이 해결되셨나요?"처럼 사용자 확인 질문으로 끝낼 것
            6. "[완료]" 같은 종료 태그를 절대 출력하지 말 것. 세션 종료 여부는 사용자가 앱 버튼으로 결정한다
            7. 포맷, Windows 재설치, 초기화, 파티션 삭제, BIOS 저장/초기화처럼 되돌리기 어렵거나 데이터 손실 가능성이 있는 조작은 즉시 실행 지시하지 말 것
            8. 데이터 손실 가능성이 있으면 먼저 백업 여부, 설치 USB/제품키/드라이버 준비 여부, 전원 연결 상태를 확인하고 위험을 한 문장으로 알려줄 것

            OpenCV 전처리 요약은 화면 품질과 BIOS 화면 정면화 여부를 판단하는 보조 근거로만 사용하세요.

            OCR 후보 영역이 제공되면, 사용자가 눌러야 할 메뉴/버튼/탭과 가장 가까운 후보 id를 overlay.targetId로 고르세요.
            정확히 매칭되는 후보가 없거나 화면에서 조작 위치를 확신할 수 없으면 overlay는 null로 두세요.
            overlay.targetId는 반드시 제공된 OCR 후보 id 중 하나여야 합니다.
            세션 목표 작업이 제공되면 모든 응답은 그 목표를 완료하기 위한 파이프라인의 다음 단계여야 합니다.
            이전 대화와 현재 화면을 함께 보고, 사용자가 목표를 완료했거나 문제를 해결했다고 명시하기 전까지 목표를 잊지 마세요.
            previousActionResult=tried이면 사용자가 직전 안내를 수행한 뒤 바뀐 화면을 보여준 상황입니다. 바뀐 화면을 확인하고 다음 단계로 진행하세요.
            previousActionResult=unresolved이면 사용자가 직전 안내를 수행하지 못했거나 같은 화면에서 막힌 상황입니다. 같은 조치를 반복하지 말고 더 구체적인 대체 경로나 확인 포인트를 제시하세요.
            사용자 질문이 제공된 경우, 그 질문을 사용자의 목표 작업으로 먼저 인식하세요.
            예: "Boot Loader 순서를 변경하고 싶어요"는 BIOS/UEFI Boot Order 변경 목표로 해석하고, 현재 화면 이미지와 OCR 후보를 보며 그 목표까지 가는 다음 1단계를 안내하세요.
            질문에 직접 답하되 화면 분석과 다음 조치를 함께 연결하고, 추측을 단정하지 말고 확인해야 할 화면 단서나 조작을 1~2개로 좁혀서 말하세요.

            다음 JSON 형식으로만 응답하세요. 코드블록, 마크다운, 추가 설명은 금지합니다:
            {
              "message": "사용자에게 보여줄 3~5문장 이내의 한국어 안내",
              "overlay": {"targetId":"OCR 후보 id","label":"여기를 선택","reason":"짧은 선택 근거"}
            }%s%s%s%s%s%s
            """.formatted(contextDesc, historyText, cvText, ocrText, goalText, questionText, workflowText);
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
                    if (!targetId.isBlank() && isKnownOcrTarget(targetId, ocrRegions)) {
                        overlay = new GuideOverlay(targetId, label, reason);
                    }
                }
                return new GuideModelResponse(message, overlay);
            } catch (Exception ignored) {
                // 기존 텍스트 응답과 모델 형식 이탈은 아래 폴백으로 처리
            }
        }

        return new GuideModelResponse(cleaned, null);
    }

    private boolean isKnownOcrTarget(String targetId, List<Map<String, Object>> ocrRegions) {
        if (ocrRegions == null || ocrRegions.isEmpty()) return false;
        return ocrRegions.stream()
            .map(region -> Objects.toString(region.get("id"), ""))
            .anyMatch(targetId::equals);
    }

    // ── 내부 레코드 ───────────────────────────────────────────────────────────

    private record GuideSession(String sessionId, String context, Instant createdAt) {}
    private record GuideModelResponse(String message, GuideOverlay overlay) {}
    private record GuideOverlay(String targetId, String label, String reason) {}
}
