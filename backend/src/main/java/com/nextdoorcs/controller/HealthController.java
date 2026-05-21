package com.nextdoorcs.controller;

import com.nextdoorcs.service.GeminiService;
import lombok.RequiredArgsConstructor;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
public class HealthController {

    @Value("${gemini.api.key:}")
    private String geminiApiKey;

    @Value("${gemini.model:gemini-3.5-flash}")
    private String geminiModel;

    private final GeminiService geminiService;

    @GetMapping("/api/health")
    public Map<String, String> health() {
        return Map.of(
                "status", "ok",
                "timestamp", Instant.now().toString());
    }

    @GetMapping("/api/health/llm")
    public Map<String, Object> llmHealth() {
        boolean configured = geminiApiKey != null && !geminiApiKey.isBlank();
        return Map.of(
                "status", configured ? "configured" : "missing_api_key",
                "provider", "gemini",
                "model", geminiModel,
                "apiKeyConfigured", configured,
                "timestamp", Instant.now().toString());
    }

    /**
     * Gemini 실제 연결 테스트 — 최소 프롬프트로 API 호출 후 응답 확인
     * GET /api/health/gemini-ping
     */
    @GetMapping("/api/health/gemini-ping")
    public Map<String, Object> geminiPing() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("model", geminiModel);
        result.put("timestamp", Instant.now().toString());

        if (geminiApiKey == null || geminiApiKey.isBlank()) {
            result.put("status", "error");
            result.put("error", "GEMINI_API_KEY가 설정되지 않았습니다.");
            return result;
        }

        long start = System.currentTimeMillis();
        try {
            String response = geminiService.ping();
            long elapsed = System.currentTimeMillis() - start;

            result.put("status", "ok");
            result.put("responseMs", elapsed);
            result.put("preview", response.length() > 100 ? response.substring(0, 100) + "…" : response);
        } catch (Exception e) {
            long elapsed = System.currentTimeMillis() - start;
            result.put("status", "error");
            result.put("responseMs", elapsed);
            result.put("error", e.getMessage());
        }

        return result;
    }
}
