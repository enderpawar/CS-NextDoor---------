package com.nextdoorcs.controller;

import com.nextdoorcs.dto.DiagnosisResponse;
import com.nextdoorcs.dto.HypothesisRequest;
import com.nextdoorcs.dto.HypothesisResponse;
import com.nextdoorcs.dto.PatternsRequest;
import com.nextdoorcs.dto.PatternsResponse;
import com.nextdoorcs.dto.SoftwareDiagnosisRequest;
import com.nextdoorcs.dto.SoftwareDiagnosisResponse;
import com.nextdoorcs.exception.DiagnosisException;
import com.nextdoorcs.ratelimit.ApiRateLimiter;
import com.nextdoorcs.service.DiagnosisService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.util.Base64;
import java.util.Map;

@RestController
@RequestMapping("/api/diagnosis")
@RequiredArgsConstructor
public class DiagnosisController {

    private final DiagnosisService diagnosisService;
    private final ApiRateLimiter rateLimiter;

    /**
     * POST /api/diagnosis/hardware
     * PWA → HW 진단 (이미지 + 선택적 오디오)
     */
    @PostMapping("/hardware")
    public ResponseEntity<?> diagnoseHardware(
            @RequestParam(value = "image", required = false) MultipartFile image,
            @RequestParam(value = "audio", required = false) MultipartFile audio,
            @RequestParam(value = "audioMimeType", required = false) String audioMimeType,
            @RequestParam("symptom") String symptom,
            @RequestParam(value = "biosType", required = false) String biosType,
            @RequestParam(value = "sessionId", required = false) String sessionId,
            HttpServletRequest request) throws IOException {

        rateLimiter.checkLimit("hardware", getClientIp(request));

        String base64Image = image != null && !image.isEmpty()
            ? Base64.getEncoder().encodeToString(image.getBytes())
            : null;
        byte[] audioBytes = audio != null ? audio.getBytes() : null;

        DiagnosisResponse response = diagnosisService.diagnoseMultimodal(
            base64Image, audioBytes, audioMimeType, symptom, biosType
        );
        return ResponseEntity.ok(response);
    }

    /**
     * POST /api/diagnosis/hypotheses
     * Electron → SW 가설 생성 (증상 + 시스템 스냅샷 + 선택적 클립보드 이미지)
     */
    @PostMapping("/hypotheses")
    public ResponseEntity<?> generateHypotheses(
            @RequestBody HypothesisRequest req,
            HttpServletRequest request) {

        rateLimiter.checkLimit("software", getClientIp(request));

        HypothesisResponse response = diagnosisService.generateHypotheses(req);
        return ResponseEntity.ok(response);
    }

    /**
     * POST /api/diagnosis/software
     * Electron → SW 가설 확정 (재현 성공 후 baseline + delta 전송)
     */
    @PostMapping("/software")
    public ResponseEntity<?> confirmSoftwareDiagnosis(
            @RequestBody SoftwareDiagnosisRequest req,
            HttpServletRequest request) {

        rateLimiter.checkLimit("software", getClientIp(request));

        SoftwareDiagnosisResponse response = diagnosisService.confirmSoftwareDiagnosis(req);
        return ResponseEntity.ok(response);
    }

    /**
     * POST /api/diagnosis/patterns
     * Electron → 이벤트 로그 기반 패턴 제안 (재현 실패 시 호출)
     */
    @PostMapping("/patterns")
    public ResponseEntity<?> suggestPatterns(
            @RequestBody PatternsRequest req,
            HttpServletRequest request) {

        rateLimiter.checkLimit("software", getClientIp(request));

        PatternsResponse response = diagnosisService.suggestPatterns(req);
        return ResponseEntity.ok(response);
    }

    /**
     * POST /api/diagnosis/{id}/feedback
     * 진단 결과 피드백 (Phase 10에서 DB 저장 추가 예정)
     */
    @PostMapping("/{id}/feedback")
    public ResponseEntity<Void> feedback(
            @PathVariable String id,
            @RequestBody Map<String, String> body) {
        // Phase 10에서 DB 저장 구현
        return ResponseEntity.ok().build();
    }

    // ── 전역 예외 처리 ─────────────────────────────────────────────────────────

    @ExceptionHandler(DiagnosisException.class)
    public ResponseEntity<Map<String, String>> handleDiagnosisException(DiagnosisException e) {
        return ResponseEntity.status(e.getHttpStatus()).body(Map.of("error", e.getMessage()));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, String>> handleGenericException(Exception e) {
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
            .body(Map.of("error", "서버 오류가 발생했어요: " + e.getMessage()));
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    private String getClientIp(HttpServletRequest request) {
        String forwarded = request.getHeader("X-Forwarded-For");
        if (forwarded != null && !forwarded.isBlank()) {
            return forwarded.split(",")[0].trim();
        }
        return request.getRemoteAddr();
    }
}
