import { describe, expect, it } from 'vitest';
import { detectBiosVendor } from './biosPipeline';

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
