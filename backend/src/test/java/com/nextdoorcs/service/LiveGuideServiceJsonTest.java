package com.nextdoorcs.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class LiveGuideServiceJsonTest {

    private LiveGuideService service;

    @BeforeEach
    void setUp() {
        service = new LiveGuideService(null, new ObjectMapper());
    }

    @Test
    void parseGuideResponse_validOverlay_keepsKnownTarget() throws Exception {
        String raw = """
            {"message":"Boot 탭을 선택해주세요.","overlay":{"targetId":"ocr-word-2","label":"여기를 선택","reason":"Boot 메뉴 후보"}}
            """;

        Object result = invokeParseGuideResponse(raw, List.of(
            Map.of("id", "ocr-word-2", "text", "Boot")
        ));

        Object overlay = invokeAccessor(result, "overlay");
        assertThat(invokeAccessor(result, "message")).isEqualTo("Boot 탭을 선택해주세요.");
        assertThat(invokeAccessor(overlay, "targetId")).isEqualTo("ocr-word-2");
    }

    @Test
    void parseGuideResponse_unknownOverlayTarget_dropsOverlay() throws Exception {
        String raw = """
            {"message":"Boot 탭을 선택해주세요.","overlay":{"targetId":"made-up-id","label":"여기를 선택"}}
            """;

        Object result = invokeParseGuideResponse(raw, List.of(
            Map.of("id", "ocr-word-2", "text", "Boot")
        ));

        assertThat(invokeAccessor(result, "message")).isEqualTo("Boot 탭을 선택해주세요.");
        assertThat(invokeAccessor(result, "overlay")).isNull();
    }

    @Test
    void parseGuideResponse_bboxOnlyOverlay_keepsVisionTarget() throws Exception {
        String raw = """
            {"message":"Boot Option #1을 선택해주세요.","overlay":{"label":"여기를 클릭하세요!","reason":"부팅 1순위 항목","bbox":{"x":220,"y":710,"w":360,"h":42,"unit":"normalized1000"}}}
            """;

        Object result = invokeParseGuideResponse(raw, List.of());
        Object overlay = invokeAccessor(result, "overlay");
        @SuppressWarnings("unchecked")
        Map<String, Object> bbox = (Map<String, Object>) invokeAccessor(overlay, "bbox");

        assertThat(invokeAccessor(overlay, "targetId")).isNull();
        assertThat(invokeAccessor(overlay, "label")).isEqualTo("여기를 클릭하세요!");
        assertThat(bbox).containsEntry("unit", "normalized1000");
        assertThat((Double) bbox.get("x")).isEqualTo(220.0);
    }

    @Test
    void parseGuideResponse_bboxWithNonNormalized1000Unit_isRejected() throws Exception {
        // pixel/normalized01 unit이 오면 clamp가 좌표를 망가뜨리므로 overlay를 거부해야 한다.
        // (프론트는 OCR fallback으로 자동 전환되어 AR 박스가 잘못 위치하는 사고를 막는다.)
        String pixelRaw = """
            {"message":"Boot Option #1을 선택해주세요.","overlay":{"label":"여기를 클릭하세요!","bbox":{"x":420,"y":860,"w":520,"h":48,"unit":"pixel"}}}
            """;
        Object pixelResult = invokeParseGuideResponse(pixelRaw, List.of());
        assertThat(invokeAccessor(pixelResult, "overlay")).isNull();

        String normalized01Raw = """
            {"message":"Boot Option #1을 선택해주세요.","overlay":{"label":"여기를 클릭하세요!","bbox":{"x":0.22,"y":0.71,"w":0.36,"h":0.04,"unit":"normalized01"}}}
            """;
        Object normalized01Result = invokeParseGuideResponse(normalized01Raw, List.of());
        assertThat(invokeAccessor(normalized01Result, "overlay")).isNull();
    }

    @Test
    void parseGuideResponse_plainText_fallsBackWithoutOverlay() throws Exception {
        Object result = invokeParseGuideResponse("Boot 메뉴를 찾아주세요.", List.of());

        assertThat(invokeAccessor(result, "message")).isEqualTo("Boot 메뉴를 찾아주세요.");
        assertThat(invokeAccessor(result, "overlay")).isNull();
    }

    @Test
    void buildGuidePrompt_goalMode_requiresOverlayAndForbidsInventedTarget() throws Exception {
        String prompt = invokeBuildGuidePrompt(
            "BIOS_BOOT",
            List.of(),
            "manualCapture=true",
            List.of(),
            null,
            "BIOS에서 Secure Boot를 끄고 싶어요."
        );

        assertThat(prompt).contains("★목표: BIOS에서 Secure Boot를 끄고 싶어요.");
        assertThat(prompt).contains("실제로 눌러야 하는 버튼/메뉴 행 1개");
        assertThat(prompt).contains("targetId 없이 bbox만 제공");
        assertThat(prompt).contains("예시 1 (후보 없음·전부 무관)");
        assertThat(prompt).contains("\"unit\":\"normalized1000\"");
        assertThat(prompt).contains("BIOS 이미지 전체나 큰 패널을 지정하지 않는다");
    }

    @Test
    void buildGuidePrompt_diagnosisMode_requiresOverlayAndForbidsInventedTarget() throws Exception {
        String prompt = invokeBuildGuidePrompt(
            "GENERAL",
            List.of(),
            "manualCapture=true",
            List.of(),
            null,
            null
        );

        assertThat(prompt).contains("실제로 눌러야 하는 버튼/메뉴 행 1개");
        assertThat(prompt).contains("targetId 없이 bbox만 제공");
        assertThat(prompt).contains("예시 1 (후보 없음·전부 무관)");
        assertThat(prompt).contains("\"unit\":\"normalized1000\"");
        assertThat(prompt).contains("BIOS 이미지 전체나 큰 패널을 지정하지 않는다");
    }

    @Test
    void normalizeOverlayInstruction_forcesClickLabelWithoutChangingNonEmptyMessage() throws Exception {
        Object parsed = invokeParseGuideResponse(
            """
            {"message":"Boot 메뉴가 보여요. 다음 항목을 선택하면 됩니다.","overlay":{"targetId":"ocr-1","label":"Boot","reason":"Boot 항목입니다."}}
            """,
            List.of(Map.of("id", "ocr-1", "text", "Boot"))
        );

        Object normalized = invokeNormalizeOverlayInstruction(parsed);
        assertThat(invokeAccessor(normalized, "message").toString())
            .isEqualTo("Boot 메뉴가 보여요. 다음 항목을 선택하면 됩니다.");

        Object overlay = invokeAccessor(normalized, "overlay");
        assertThat(invokeAccessor(overlay, "label")).isEqualTo("여기를 클릭하세요!");
        assertThat(invokeAccessor(overlay, "targetId")).isEqualTo("ocr-1");
    }

    @Test
    void autoOverlayFromMessage_recoversMissingOverlayFromMentionedOcrText() throws Exception {
        Object parsed = invokeParseGuideResponse(
            """
            {"message":"Boot Option #1 항목을 선택해서 USB를 1순위로 바꿔주세요.","overlay":null}
            """,
            List.of(Map.of("id", "ocr-line-3", "text", "Boot Option #1"))
        );

        Object recovered = invokeAutoOverlayFromMessage(parsed, List.of(
            Map.of("id", "ocr-line-1", "text", "Advanced Mode"),
            Map.of("id", "ocr-line-3", "text", "Boot Option #1")
        ));

        Object overlay = invokeAccessor(recovered, "overlay");
        assertThat(invokeAccessor(overlay, "targetId")).isEqualTo("ocr-line-3");
        assertThat(invokeAccessor(overlay, "label")).isEqualTo("여기를 클릭하세요!");
        assertThat(invokeAccessor(overlay, "reason").toString()).contains("Boot Option #1");
    }

    @Test
    void buildGuidePrompt_includesCompactOcrCandidateJsonForServerOverlayPath() throws Exception {
        String prompt = invokeBuildGuidePrompt(
            "BIOS_BOOT",
            List.of(),
            "manualCapture=true, ocrRegions=2",
            List.of(
                Map.of("id", "ocr-line-1", "text", "Advanced", "confidence", 0.82),
                Map.of("id", "ocr-line-2", "text", "Boot Option #1", "confidence", 0.76)
            ),
            null,
            "USB 부팅을 먼저 하고 싶어요."
        );

        assertThat(prompt).contains("OCR 후보 영역(JSON, 원본 프레임 좌표)");
        assertThat(prompt).contains("\"id\":\"ocr-line-2\"");
        assertThat(prompt).contains("\"text\":\"Boot Option #1\"");
        assertThat(prompt).contains("OCR이 부정확하면 targetId 없이 bbox만 제공");
    }

    @SuppressWarnings("unchecked")
    private Object invokeParseGuideResponse(String raw, List<Map<String, Object>> ocrRegions) throws Exception {
        var method = LiveGuideService.class.getDeclaredMethod("parseGuideResponse", String.class, List.class);
        method.setAccessible(true);
        return method.invoke(service, raw, ocrRegions);
    }

    private Object invokeAccessor(Object target, String methodName) throws Exception {
        var method = target.getClass().getDeclaredMethod(methodName);
        method.setAccessible(true);
        return method.invoke(target);
    }

    private String invokeBuildGuidePrompt(
            String context,
            List<Map<String, String>> history,
            String cvSummary,
            List<Map<String, Object>> ocrRegions,
            String userQuestion,
            String taskGoal) throws Exception {
        var method = LiveGuideService.class.getDeclaredMethod(
            "buildGuidePrompt",
            String.class,
            List.class,
            String.class,
            List.class,
            String.class,
            String.class
        );
        method.setAccessible(true);
        return (String) method.invoke(service, context, history, cvSummary, ocrRegions, userQuestion, taskGoal);
    }

    private Object invokeNormalizeOverlayInstruction(Object response) throws Exception {
        var method = LiveGuideService.class.getDeclaredMethod(
            "normalizeOverlayInstruction",
            response.getClass()
        );
        method.setAccessible(true);
        return method.invoke(service, response);
    }

    private Object invokeAutoOverlayFromMessage(Object response, List<Map<String, Object>> ocrRegions) throws Exception {
        var method = LiveGuideService.class.getDeclaredMethod(
            "autoOverlayFromMessage",
            response.getClass(),
            List.class
        );
        method.setAccessible(true);
        return method.invoke(service, response, ocrRegions);
    }
}
