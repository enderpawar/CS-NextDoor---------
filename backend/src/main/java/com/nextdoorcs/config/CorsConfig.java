package com.nextdoorcs.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class CorsConfig implements WebMvcConfigurer {

    @Value("${allowed.origins:http://localhost:3000}")
    private String allowedOrigins;

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        // 허용 오리진: env 설정값 + Electron 고정 오리진
        String[] origins = buildOrigins(allowedOrigins);

        registry.addMapping("/api/**")
                .allowedOriginPatterns(origins)
                .allowedMethods("GET", "POST", "PUT", "DELETE", "OPTIONS")
                .allowedHeaders("*")
                .allowCredentials(false)
                .maxAge(3600);
    }

    private String[] buildOrigins(String envOrigins) {
        // Electron은 app:// 또는 file:// 오리진 사용 — 항상 허용
        String[] extra = {"app://.", "file://"};
        String[] env = envOrigins.split(",");
        for (int i = 0; i < env.length; i += 1) {
            env[i] = env[i].trim();
        }
        String[] all = new String[env.length + extra.length];
        System.arraycopy(env, 0, all, 0, env.length);
        System.arraycopy(extra, 0, all, env.length, extra.length);
        return all;
    }
}
