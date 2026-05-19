package com.nextdoorcs.controller;

import java.time.Instant;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class HealthController {

    @Value("${gemini.api.key:}")
    private String geminiApiKey;

    @Value("${gemini.model:gemini-2.0-flash}")
    private String geminiModel;

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
}
