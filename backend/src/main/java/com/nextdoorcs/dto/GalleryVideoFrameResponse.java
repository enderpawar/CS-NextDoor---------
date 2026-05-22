package com.nextdoorcs.dto;

public record GalleryVideoFrameResponse(
    String frameBase64,
    int width,
    int height,
    String cvSummary
) {}
