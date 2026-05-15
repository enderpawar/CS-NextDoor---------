package com.nextdoorcs.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.web.filter.ForwardedHeaderFilter;
import org.springframework.web.client.RestTemplate;

@Configuration
@EnableScheduling
public class AppConfig {

    @Bean
    public RestTemplate restTemplate() {
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(5_000);   // 5초 — Gemini 연결 타임아웃
        factory.setReadTimeout(30_000);     // 30초 — 멀티모달 응답 대기
        return new RestTemplate(factory);
    }

    /**
     * Render 등 리버스 프록시 환경에서 X-Forwarded-For 헤더를 신뢰.
     * Spring이 request.getRemoteAddr() 대신 헤더 값을 반환하도록 위임.
     * 직접 노출 환경에서는 프록시 IP 화이트리스트 추가 필요.
     */
    @Bean
    public ForwardedHeaderFilter forwardedHeaderFilter() {
        return new ForwardedHeaderFilter();
    }
}
