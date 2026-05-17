package com.nextdoorcs.dto;

import java.util.List;
import java.util.Map;

public record GuideFrameRequest(
    String frameBase64,
    List<Map<String, String>> history,  // [{role: "user"|"model", text: "..."}]
    String cvSummary,                   // OpenCV.js 모듈 1/2/3 전처리 요약
    List<Map<String, Object>> ocrRegions, // [{id,text,confidence,bbox,points}]
    String userQuestion,                 // 사용자가 현재 화면에 대해 직접 입력한 질문
    String taskGoal                      // 세션 전체에서 유지할 사용자 목표 작업
) {}
