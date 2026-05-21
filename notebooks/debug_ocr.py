"""OCR 디버그 - 실제 출력 텍스트 확인 + 모니터 영역 추출"""
import cv2
import numpy as np
import pytesseract
from pathlib import Path

pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'
IMG_DIR = Path(r'C:\Users\user\Desktop\CS-NextDoor\test data')
OUT_DIR = Path(r'C:\Users\user\Desktop\CS-NextDoor\docs\cv-pipeline')

def find_screen_roi(img_bgr):
    """모니터 화면 ROI 추출: 가장 큰 밝은 사각형 찾기"""
    h, w = img_bgr.shape[:2]
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)

    # 블러 + 엣지
    blur = cv2.GaussianBlur(gray, (9, 9), 0)
    edges = cv2.Canny(blur, 30, 100)
    # 모폴로지 닫기
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 15))
    closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel)

    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    best_roi = None
    best_area = 0
    for cnt in contours:
        peri = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, 0.02 * peri, True)
        if len(approx) == 4:
            area = cv2.contourArea(approx)
            if area > best_area and area > (w * h * 0.1):
                best_area = area
                best_roi = approx
    return best_roi

def warp_screen(img_bgr, quad):
    """4점 → perspective 보정"""
    pts = quad.reshape(4, 2).astype(np.float32)
    rect = np.zeros((4, 2), dtype=np.float32)
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]

    widthA  = np.linalg.norm(rect[2] - rect[3])
    widthB  = np.linalg.norm(rect[1] - rect[0])
    heightA = np.linalg.norm(rect[1] - rect[2])
    heightB = np.linalg.norm(rect[0] - rect[3])
    maxW = int(max(widthA, widthB))
    maxH = int(max(heightA, heightB))

    dst = np.array([[0,0],[maxW-1,0],[maxW-1,maxH-1],[0,maxH-1]], dtype=np.float32)
    M = cv2.getPerspectiveTransform(rect, dst)
    return cv2.warpPerspective(img_bgr, M, (maxW, maxH))

def ocr_text(gray):
    try:
        t = pytesseract.image_to_string(gray, lang='eng', config='--psm 6 --oem 3')
        return ' '.join(t.split())
    except:
        return ''

results = []
for fname in sorted(IMG_DIR.glob('KakaoTalk_*.jpg')):
    img = cv2.imread(str(fname))
    if img is None:
        continue
    h, w = img.shape[:2]
    # 다운스케일 (처리 속도)
    scale = min(1.0, 1920 / max(h, w))
    small = cv2.resize(img, (int(w*scale), int(h*scale)))

    roi = find_screen_roi(small)
    if roi is not None:
        warped = warp_screen(small, roi)
        gray_w = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY)
    else:
        gray_w = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)

    # 전처리
    clahe = cv2.createCLAHE(2.0, (8,8)).apply(gray_w)

    # OCR
    raw_text  = ocr_text(gray_w)
    proc_text = ocr_text(clahe)

    results.append({
        'file': fname.name,
        'roi_found': roi is not None,
        'raw': raw_text[:150],
        'clahe': proc_text[:150],
    })
    print(f"[{fname.name[-6:-4]}] roi={roi is not None} | raw: {raw_text[:80].encode('ascii','replace').decode()}")

# 파일로 저장 (인코딩 안전)
with open(r'C:\Users\user\Desktop\CS-NextDoor\notebooks\debug_ocr_output.txt', 'w', encoding='utf-8') as f:
    for r in results:
        f.write(f"=== {r['file']} (roi={r['roi_found']}) ===\n")
        f.write(f"RAW:   {r['raw']}\n")
        f.write(f"CLAHE: {r['clahe']}\n\n")

print("\n디버그 결과 -> notebooks/debug_ocr_output.txt")
