package com.nextdoorcs.dto;

import java.util.List;
import java.util.Map;

public record GuideFrameRequest(
    String frameBase64,
    List<Map<String, String>> history,  // [{role: "user"|"model", text: "..."}]
    String cvSummary                    // OpenCV.js 모듈 1/2/3 전처리 요약
) {}
