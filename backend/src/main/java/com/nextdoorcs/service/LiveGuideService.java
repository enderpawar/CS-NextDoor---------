package com.nextdoorcs.service;

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
            String cvSummary) {

        GuideSession session = sessions.get(sessionId);
        if (session == null) throw new DiagnosisException("가이드 세션을 찾을 수 없어요: " + sessionId);

        SseEmitter emitter = new SseEmitter(60_000L);

        CompletableFuture.runAsync(() -> {
            try {
                String prompt = buildGuidePrompt(session.context(), history, cvSummary);
                String response = geminiService.generateGuideResponse(prompt, frameBase64);

                // 텍스트를 단어 단위로 청크 분할하여 스트리밍 효과
                String[] words = response.split("(?<=\\s)");
                for (String word : words) {
                    try {
                        emitter.send(SseEmitter.event().data(word));
                        Thread.sleep(20);  // 타이핑 효과
                    } catch (IOException e) {
                        emitter.completeWithError(e);
                        return;
                    }
                }

                // [완료] 태그가 응답에 없으면 추가하지 않음 — Gemini가 판단
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

    private String buildGuidePrompt(String context, List<Map<String, String>> history, String cvSummary) {
        String historyText = (history == null || history.isEmpty())
            ? ""
            : "\n\n이전 대화:\n" + history.stream()
                .map(m -> m.getOrDefault("role", "user") + ": " + m.getOrDefault("text", ""))
                .collect(Collectors.joining("\n"));

        String cvText = (cvSummary == null || cvSummary.isBlank())
            ? ""
            : "\n\nOpenCV 전처리 요약:\n" + cvSummary;

        String contextDesc = switch (context) {
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
            3. 정확한 원인 판별에 PC 내부 데이터가 필요하면 "더 정확한 진단이 필요하다면 컴퓨터에서 만나요."라고 자연스럽게 안내
            4. 작업이 완전히 완료됐으면 응답 끝에 "[완료]" 태그 포함

            OpenCV 전처리 요약은 화면 품질과 BIOS 화면 정면화 여부를 판단하는 보조 근거로만 사용하세요.
            답변은 3~5문장 이내로 간결하게.%s%s
            """.formatted(contextDesc, historyText, cvText);
    }

    // ── 내부 레코드 ───────────────────────────────────────────────────────────

    private record GuideSession(String sessionId, String context, Instant createdAt) {}
}
