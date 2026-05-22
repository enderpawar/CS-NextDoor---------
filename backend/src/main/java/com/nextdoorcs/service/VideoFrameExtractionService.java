package com.nextdoorcs.service;

import com.nextdoorcs.dto.GalleryVideoFrameResponse;
import com.nextdoorcs.exception.DiagnosisException;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

@Slf4j
@Service
public class VideoFrameExtractionService {

    private static final long MAX_VIDEO_BYTES = 50L * 1024L * 1024L;
    private static final double MAX_DURATION_SEC = 15.0;
    private static final Duration PROCESS_TIMEOUT = Duration.ofSeconds(20);

    public GalleryVideoFrameResponse extractRepresentativeFrame(MultipartFile file) {
        validateFile(file);

        Path workDir = null;
        try {
            workDir = Files.createTempDirectory("nextdoorcs-video-");
            String extension = extensionFor(file.getOriginalFilename(), file.getContentType());
            Path input = workDir.resolve("input-" + UUID.randomUUID() + extension);
            Path output = workDir.resolve("frame.jpg");
            file.transferTo(input);

            double duration = probeDuration(input);
            if (!Double.isFinite(duration) || duration <= 0) {
                throw new DiagnosisException("동영상 길이를 확인할 수 없어요.", HttpStatus.UNPROCESSABLE_ENTITY.value());
            }
            if (duration > MAX_DURATION_SEC) {
                throw new DiagnosisException("동영상은 15초 이하만 분석할 수 있어요.", HttpStatus.PAYLOAD_TOO_LARGE.value());
            }

            double seekSec = Math.max(0, Math.min(duration * 0.35, duration - 0.05));
            extractFrame(input, output, seekSec);

            BufferedImage image = ImageIO.read(output.toFile());
            if (image == null || image.getWidth() <= 0 || image.getHeight() <= 0) {
                throw new DiagnosisException("동영상에서 분석할 프레임을 찾지 못했어요.", HttpStatus.UNPROCESSABLE_ENTITY.value());
            }

            String base64 = Base64.getEncoder().encodeToString(Files.readAllBytes(output));
            String cvSummary = String.join(", ",
                "captureSource=serverVideoFallback",
                "serverTranscodedFrame=true",
                "videoDurationMs=" + Math.round(duration * 1000),
                "selectedFrameAtMs=" + Math.round(seekSec * 1000),
                "sourceMimeType=" + safeMime(file.getContentType())
            );

            return new GalleryVideoFrameResponse(base64, image.getWidth(), image.getHeight(), cvSummary);
        } catch (DiagnosisException e) {
            throw e;
        } catch (IOException e) {
            log.warn("Video frame extraction I/O failed", e);
            throw new DiagnosisException("동영상 파일을 처리할 수 없어요.", HttpStatus.UNPROCESSABLE_ENTITY.value());
        } finally {
            deleteRecursively(workDir);
        }
    }

    private static void validateFile(MultipartFile file) {
        if (file == null || file.isEmpty()) {
            throw new DiagnosisException("업로드된 동영상이 없어요.", HttpStatus.BAD_REQUEST.value());
        }
        if (file.getSize() > MAX_VIDEO_BYTES) {
            throw new DiagnosisException("동영상은 50MB 이하만 분석할 수 있어요.", HttpStatus.PAYLOAD_TOO_LARGE.value());
        }
        String contentType = safeMime(file.getContentType());
        String name = file.getOriginalFilename() == null ? "" : file.getOriginalFilename().toLowerCase(Locale.ROOT);
        boolean likelyVideo = contentType.startsWith("video/")
            || name.endsWith(".mov")
            || name.endsWith(".mp4")
            || name.endsWith(".m4v")
            || name.endsWith(".webm");
        if (!likelyVideo) {
            throw new DiagnosisException("사진이나 동영상 파일만 업로드할 수 있어요.", HttpStatus.UNSUPPORTED_MEDIA_TYPE.value());
        }
    }

    private static double probeDuration(Path input) {
        ProcessResult result = runProcess(List.of(
            "ffprobe",
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            input.toString()
        ));
        if (result.exitCode() != 0) {
            throw new DiagnosisException("동영상 정보를 읽을 수 없어요.", HttpStatus.UNPROCESSABLE_ENTITY.value());
        }
        try {
            return Double.parseDouble(result.stdout().trim());
        } catch (NumberFormatException e) {
            throw new DiagnosisException("동영상 길이를 확인할 수 없어요.", HttpStatus.UNPROCESSABLE_ENTITY.value());
        }
    }

    private static void extractFrame(Path input, Path output, double seekSec) {
        ProcessResult result = runProcess(List.of(
            "ffmpeg",
            "-y",
            "-ss", String.format(Locale.US, "%.3f", seekSec),
            "-i", input.toString(),
            "-frames:v", "1",
            "-vf", "scale=min(1280\\,iw):-2",
            "-q:v", "3",
            output.toString()
        ));
        if (result.exitCode() != 0 || !Files.exists(output)) {
            log.warn("ffmpeg failed: {}", result.stderr());
            throw new DiagnosisException("동영상에서 분석할 프레임을 찾지 못했어요.", HttpStatus.UNPROCESSABLE_ENTITY.value());
        }
    }

    private static ProcessResult runProcess(List<String> command) {
        try {
            Process process = new ProcessBuilder(command).start();
            CompletableFuture<String> stdoutFuture = CompletableFuture.supplyAsync(() -> readProcessStream(process.getInputStream()));
            CompletableFuture<String> stderrFuture = CompletableFuture.supplyAsync(() -> readProcessStream(process.getErrorStream()));
            boolean finished = process.waitFor(PROCESS_TIMEOUT.toSeconds(), TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                process.waitFor(3, TimeUnit.SECONDS);
                throw new DiagnosisException("동영상 처리 시간이 초과됐어요.", HttpStatus.REQUEST_TIMEOUT.value());
            }
            String stdout = stdoutFuture.get(3, TimeUnit.SECONDS);
            String stderr = stderrFuture.get(3, TimeUnit.SECONDS);
            return new ProcessResult(process.exitValue(), stdout, stderr);
        } catch (IOException e) {
            throw new DiagnosisException("서버에 FFmpeg가 설치되어 있지 않아요.", HttpStatus.SERVICE_UNAVAILABLE.value());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new DiagnosisException("동영상 처리가 중단됐어요.", HttpStatus.INTERNAL_SERVER_ERROR.value());
        } catch (Exception e) {
            throw new DiagnosisException("동영상 처리 결과를 읽을 수 없어요.", HttpStatus.INTERNAL_SERVER_ERROR.value());
        }
    }

    private static String readProcessStream(java.io.InputStream stream) {
        try (stream) {
            return new String(stream.readAllBytes());
        } catch (IOException e) {
            return "";
        }
    }

    private static String extensionFor(String filename, String contentType) {
        String lower = filename == null ? "" : filename.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".mov")) return ".mov";
        if (lower.endsWith(".m4v")) return ".m4v";
        if (lower.endsWith(".webm")) return ".webm";
        if (lower.endsWith(".mp4")) return ".mp4";
        if ("video/quicktime".equalsIgnoreCase(contentType)) return ".mov";
        return ".mp4";
    }

    private static String safeMime(String value) {
        return value == null || value.isBlank() ? "unknown" : value;
    }

    private static void deleteRecursively(Path root) {
        if (root == null) return;
        try (var paths = Files.walk(root)) {
            paths.sorted((a, b) -> b.compareTo(a)).forEach(path -> {
                try {
                    Files.deleteIfExists(path);
                } catch (IOException e) {
                    log.debug("Failed to delete temp path {}", path, e);
                }
            });
        } catch (IOException e) {
            log.debug("Failed to cleanup temp dir {}", root, e);
        }
    }

    private record ProcessResult(int exitCode, String stdout, String stderr) {}
}
