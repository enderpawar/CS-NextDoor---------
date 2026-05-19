import { describe, expect, it } from 'vitest';
import { detectBiosVendor, isLikelyClickableText } from './biosPipeline';

describe('detectBiosVendor', () => {
  it('detects AMI-style UEFI and OEM BIOS text', () => {
    expect(detectBiosVendor('American Megatrends Aptio Setup Utility')).toBe('AMI');
    expect(detectBiosVendor('ASUS UEFI BIOS Utility - Advanced Mode')).toBe('AMI');
  });

  it('detects Award and Phoenix variants before AMI fallback', () => {
    expect(detectBiosVendor('Award Modular BIOS v6.00PG')).toBe('Award');
    expect(detectBiosVendor('Phoenix-AwardBIOS CMOS Setup Utility')).toBe('Phoenix');
  });

  it('returns null when no vendor keyword is present', () => {
    expect(detectBiosVendor('Boot priority and secure boot settings')).toBeNull();
  });
});

describe('isLikelyClickableText', () => {
  it('keeps short BIOS action labels that users may need to select', () => {
    expect(isLikelyClickableText('OK')).toBe(true);
    expect(isLikelyClickableText('F10')).toBe(true);
    expect(isLikelyClickableText('ESC')).toBe(true);
  });

  it('rejects short OCR noise', () => {
    expect(isLikelyClickableText('--')).toBe(false);
    expect(isLikelyClickableText('!')).toBe(false);
  });
});
