from __future__ import annotations

import csv
import json
import shutil
import time
from pathlib import Path
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

import cv2
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
USER_AGENT = "NextDoor-CS-CV-TestData/0.1 (local academic CV test dataset; Wikimedia Commons)"


BIOS_ASSETS = [
    {
        "filename": "Award_BIOS_setup_utility.png",
        "local": "award/award-bios-setup-utility.png",
        "vendor": "award",
        "angle_deg": 0,
        "lighting": "screenshot",
        "top_menu_text": "CMOS SETUP UTILITY STANDARD CMOS FEATURES ADVANCED BIOS FEATURES",
        "source_url": "https://commons.wikimedia.org/wiki/File:Award_BIOS_setup_utility.png",
        "author": "Award Software International Inc.; recreated by User:Kephir",
        "license": "Wikimedia Commons file page terms",
        "notes": "Depiction of Award BIOS setup utility; useful for text/layout OCR sanity checks.",
    },
    {
        "filename": "SeaBIOS_1.15.0_screenshot.png",
        "local": "other/seabios-1.15.0-screenshot.png",
        "vendor": "other",
        "angle_deg": 0,
        "lighting": "screenshot",
        "top_menu_text": "SeaBIOS Machine UUID Booting from Hard Disk",
        "source_url": "https://commons.wikimedia.org/wiki/File:SeaBIOS_1.15.0_screenshot.png",
        "author": "Software: Kevin O'Connor; Screenshot: VulcanSphere",
        "license": "LGPLv3 free software screenshot",
        "notes": "SeaBIOS screenshot from Commons; black boot text screen.",
    },
    {
        "filename": "SeaBIOS_1.15.0_boot_device_selection_screenshot.png",
        "local": "other/seabios-boot-device-selection.png",
        "vendor": "other",
        "angle_deg": 0,
        "lighting": "screenshot",
        "top_menu_text": "SeaBIOS Select boot device",
        "source_url": "https://commons.wikimedia.org/wiki/File:SeaBIOS_1.15.0_boot_device_selection_screenshot.png",
        "author": "Software: Kevin O'Connor; Screenshot: VulcanSphere",
        "license": "LGPLv3 free software screenshot",
        "notes": "Boot device selection screen; useful for live guide boot menu context.",
    },
    {
        "filename": "BIOS_Setup_First_Time.jpg",
        "local": "other/bios-setup-first-time.jpg",
        "vendor": "other",
        "angle_deg": 5,
        "lighting": "photo",
        "top_menu_text": "BIOS SETUP",
        "source_url": "https://commons.wikimedia.org/wiki/File:BIOS_Setup_First_Time.jpg",
        "author": "Paul Schultz",
        "license": "CC BY 2.0",
        "notes": "Real camera photo of BIOS setup screen; useful for perspective/blur robustness.",
    },
    {
        "filename": "Coreboot%2BseaBIOS%2Bon-x60.JPG",
        "local": "other/coreboot-seabios-on-x60.jpg",
        "vendor": "other",
        "angle_deg": 15,
        "lighting": "photo",
        "top_menu_text": "SeaBIOS Coreboot",
        "source_url": "https://commons.wikimedia.org/wiki/File:Coreboot%2BseaBIOS%2Bon-x60.JPG",
        "author": "GNUtoo",
        "license": "Wikimedia Commons file page terms",
        "notes": "Real photo of SeaBIOS payload on laptop display.",
    },
]


QUALITY_ASSETS = [
    {
        "filename": "Capacitors_on_motherboard.jpg",
        "local": "commons-capacitors-on-motherboard.jpg",
        "label": "good",
        "defect_type": "none",
        "source_url": "https://commons.wikimedia.org/wiki/File:Capacitors_on_motherboard.jpg",
        "author": "Holly Cheng / Howcheng",
        "license": "CC BY-SA 3.0 / GFDL",
        "notes": "Motherboard capacitors close-up.",
    },
    {
        "filename": "Computer_motherboard_%C2%B5ATX_with_Intel_Socket_1150_IMGP8583_smial_wp.jpg",
        "local": "commons-uatx-intel-socket-1150.jpg",
        "label": "good",
        "defect_type": "none",
        "source_url": "https://commons.wikimedia.org/wiki/File:Computer_motherboard_%C2%B5ATX_with_Intel_Socket_1150_IMGP8583_smial_wp.jpg",
        "author": "Rainer Knäpper / Smial",
        "license": "Free Art License",
        "notes": "Clear modern motherboard photo.",
    },
    {
        "filename": "Apple_Macintosh_II_motherboard.jpg",
        "local": "commons-apple-macintosh-ii-motherboard.jpg",
        "label": "good",
        "defect_type": "none",
        "source_url": "https://commons.wikimedia.org/wiki/File:Apple_Macintosh_II_motherboard.jpg",
        "author": "Ransu at English Wikipedia",
        "license": "Public domain",
        "notes": "Large motherboard photo.",
    },
    {
        "filename": "Awardbioseprom.JPG",
        "local": "commons-award-bios-eprom.jpg",
        "label": "good",
        "defect_type": "none",
        "source_url": "https://commons.wikimedia.org/wiki/File:Awardbioseprom.JPG",
        "author": "Euthygenes",
        "license": "Public domain",
        "notes": "BIOS chip photo for hardware visual context.",
    },
]


def commons_redirect_url(filename: str) -> str:
    return f"https://commons.wikimedia.org/wiki/Special:Redirect/file/{quote(filename, safe='%')}"


def commons_original_url(filename: str) -> str:
    title = "File:" + filename.replace("%2B", "+").replace("_", " ")
    params = urlencode({
        "action": "query",
        "format": "json",
        "prop": "imageinfo",
        "iiprop": "url",
        "titles": title,
    })
    api_url = f"https://commons.wikimedia.org/w/api.php?{params}"
    req = Request(api_url, headers={"User-Agent": USER_AGENT})
    with urlopen(req, timeout=60) as response:
        payload = json.loads(response.read().decode("utf-8"))
    pages = payload["query"]["pages"].values()
    for page in pages:
        info = page.get("imageinfo")
        if info:
            return info[0]["url"]
    return commons_redirect_url(filename)


def download(filename: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    last_error = None
    for attempt in range(4):
        try:
            source_url = commons_original_url(filename)
            req = Request(source_url, headers={"User-Agent": USER_AGENT})
            with urlopen(req, timeout=60) as response, dest.open("wb") as out:
                shutil.copyfileobj(response, out)
            downscale_image(dest)
            time.sleep(1.2)
            return
        except Exception as exc:
            last_error = exc
            time.sleep(3 + attempt * 4)
    raise RuntimeError(f"failed to download {filename}: {last_error}")


def downscale_image(path: Path, max_width: int = 1280) -> None:
    img = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if img is None or img.shape[1] <= max_width:
        return
    scale = max_width / img.shape[1]
    resized = cv2.resize(img, (max_width, int(img.shape[0] * scale)), interpolation=cv2.INTER_AREA)
    cv2.imwrite(str(path), resized)


def remove_existing_binary_outputs() -> None:
    # Keep previously downloaded files. Wikimedia may rate-limit repeated runs;
    # preserving local files makes the script resumable.
    return


def write_manifest(rows: list[dict[str, str]]) -> None:
    path = DATA / "web-test-sources.csv"
    fieldnames = [
        "dataset",
        "local_path",
        "source_url",
        "author",
        "license",
        "notes",
    ]
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def make_bad_variants(qdir: Path, labels: list[dict[str, str]]) -> None:
    base_items = list(labels)
    for item in base_items[:3]:
        img = cv2.imread(str(qdir / item["filename"]), cv2.IMREAD_COLOR)
        if img is None:
            continue
        variants = {
            "blur": cv2.GaussianBlur(img, (25, 25), 0),
            "dark": (img.astype("float32") * 0.38).clip(0, 255).astype("uint8"),
            "bright": (img.astype("float32") * 1.75 + 35).clip(0, 255).astype("uint8"),
        }
        stem = Path(item["filename"]).stem
        for defect, variant in variants.items():
            name = f"{stem}-{defect}.jpg"
            cv2.imwrite(str(qdir / name), variant)
            labels.append({
                "filename": name,
                "label": "bad",
                "defect_type": defect,
                "source_url": item["source_url"],
                "author": item["author"],
                "license": item["license"],
                "notes": f"Derived {defect} variant for quality-filter negative sample.",
            })


def main() -> None:
    remove_existing_binary_outputs()
    manifest_rows: list[dict[str, str]] = []

    bios_rows = []
    for asset in BIOS_ASSETS:
        local_path = DATA / "bios" / asset["local"]
        if not local_path.exists():
            try:
                download(asset["filename"], local_path)
            except Exception as exc:
                print(f"SKIP {asset['filename']}: {exc}")
                continue
        bios_rows.append({
            "filename": asset["local"],
            "vendor": asset["vendor"],
            "angle_deg": asset["angle_deg"],
            "lighting": asset["lighting"],
            "top_menu_text": asset["top_menu_text"],
            "notes": f"{asset['notes']} Source: {asset['source_url']} License: {asset['license']} Author: {asset['author']}",
        })
        manifest_rows.append({
            "dataset": "bios",
            "local_path": str(local_path.relative_to(ROOT)).replace("\\", "/"),
            "source_url": asset["source_url"],
            "author": asset["author"],
            "license": asset["license"],
            "notes": asset["notes"],
        })

    pd.DataFrame(bios_rows).to_csv(DATA / "bios" / "ground-truth.csv", index=False)

    qdir = DATA / "live-frames" / "quality-mix"
    quality_rows = []
    for asset in QUALITY_ASSETS:
        local_path = qdir / asset["local"]
        if not local_path.exists():
            try:
                download(asset["filename"], local_path)
            except Exception as exc:
                print(f"SKIP {asset['filename']}: {exc}")
                continue
        quality_rows.append({
            "filename": asset["local"],
            "label": asset["label"],
            "defect_type": asset["defect_type"],
            "source_url": asset["source_url"],
            "author": asset["author"],
            "license": asset["license"],
            "notes": asset["notes"],
        })
        manifest_rows.append({
            "dataset": "quality-mix",
            "local_path": str(local_path.relative_to(ROOT)).replace("\\", "/"),
            "source_url": asset["source_url"],
            "author": asset["author"],
            "license": asset["license"],
            "notes": asset["notes"],
        })

    make_bad_variants(qdir, quality_rows)
    pd.DataFrame(quality_rows).to_csv(qdir / "labels.csv", index=False)
    write_manifest(manifest_rows)
    print("Downloaded Commons test data. Raw images are ignored by git; source manifest is data/web-test-sources.csv.")


if __name__ == "__main__":
    main()
