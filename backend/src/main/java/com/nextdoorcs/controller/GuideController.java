package com.nextdoorcs.controller;

import com.nextdoorcs.dto.GuideFrameRequest;
import com.nextdoorcs.dto.GuideStartRequest;
import com.nextdoorcs.ratelimit.ApiRateLimiter;
import com.nextdoorcs.service.LiveGuideService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;

@RestController
@RequestMapping("/api/guide")
@RequiredArgsConstructor
public class GuideController {

    private final LiveGuideService liveGuideService;
    private final ApiRateLimiter   rateLimiter;

    /**
     * POST /api/guide/start
     * 가이드 세션 생성 — context(BIOS_ENTRY 등) 전달, sessionId 반환
     */
    @PostMapping("/start")
    public ResponseEntity<Map<String, String>> startSession(
            @RequestBody GuideStartRequest req,
            HttpServletRequest httpReq) {

        rateLimiter.checkLimit(getClientIp(httpReq));
        String sessionId = liveGuideService.createSession(req.context());
        return ResponseEntity.ok(Map.of("sessionId", sessionId));
    }

    /**
     * POST /api/guide/{sessionId}/frame
     * 프레임(Base64 JPEG) + 히스토리 → text/event-stream SSE 스트리밍 응답
     * fetch() 스트리밍 사용 (EventSource는 GET 전용이므로 사용 불가)
     */
    @PostMapping(
        value    = "/{sessionId}/frame",
        produces = MediaType.TEXT_EVENT_STREAM_VALUE
    )
    public SseEmitter processFrame(
            @PathVariable String sessionId,
            @RequestBody GuideFrameRequest req,
            HttpServletRequest httpReq) {

        rateLimiter.checkLimit(getClientIp(httpReq));
        return liveGuideService.processFrame(
            sessionId,
            req.frameBase64(),
            req.history(),
            req.cvSummary()
        );
    }

    /**
     * DELETE /api/guide/{sessionId}
     * 가이드 세션 종료 — [완료] 태그 감지 또는 사용자 수동 종료 시 호출
     */
    @DeleteMapping("/{sessionId}")
    public ResponseEntity<Void> deleteSession(@PathVariable String sessionId) {
        liveGuideService.deleteSession(sessionId);
        return ResponseEntity.noContent().build();
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private String getClientIp(HttpServletRequest req) {
        String forwarded = req.getHeader("X-Forwarded-For");
        return (forwarded != null && !forwarded.isBlank())
            ? forwarded.split(",")[0].trim()
            : req.getRemoteAddr();
    }
}
