package com.nextdoorcs.ratelimit;

import com.nextdoorcs.exception.DiagnosisException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

@Component
public class ApiRateLimiter {

    @Value("${ratelimit.daily-limit:5}")
    private int dailyLimit;

    @Value("${ratelimit.guide-daily-limit:50}")
    private int guideDailyLimit;

    // key: scope + IP 주소, value: 오늘 사용 횟수
    private final ConcurrentHashMap<String, AtomicInteger> counters = new ConcurrentHashMap<>();

    /**
     * IP 기반 일일 쿼터 확인. 초과 시 DiagnosisException (HTTP 429로 매핑됨)
     */
    public void checkLimit(String ip) {
        checkLimit("diagnosis", ip);
    }

    /**
     * 기능별 버킷을 분리한다. 라이브 가이드 프레임 전송이 비프음/하드웨어 진단 쿼터를
     * 소모하지 않도록 scope를 반드시 호출 지점에서 지정한다.
     */
    public void checkLimit(String scope, String ip) {
        String key   = scope + ":" + ip;
        int    limit = "guide".equals(scope) ? guideDailyLimit : dailyLimit;
        int count = counters.computeIfAbsent(key, k -> new AtomicInteger(0))
                            .incrementAndGet();
        if (count > limit) {
            throw new DiagnosisException(
                "일일 " + scopeLabel(scope) + " 한도(" + limit + "회)를 초과했어요. 내일 다시 시도해주세요.", 429
            );
        }
    }

    private String scopeLabel(String scope) {
        return switch (scope) {
            case "guide" -> "라이브 가이드";
            default -> "진단";
        };
    }

    // 자정마다 카운터 초기화
    @Scheduled(cron = "0 0 0 * * *")
    public void resetCounters() {
        counters.clear();
    }
}
