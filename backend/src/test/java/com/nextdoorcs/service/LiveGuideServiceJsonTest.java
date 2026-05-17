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
    void parseGuideResponse_plainText_fallsBackWithoutOverlay() throws Exception {
        Object result = invokeParseGuideResponse("Boot 메뉴를 찾아주세요.", List.of());

        assertThat(invokeAccessor(result, "message")).isEqualTo("Boot 메뉴를 찾아주세요.");
        assertThat(invokeAccessor(result, "overlay")).isNull();
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
}
