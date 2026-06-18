import { describe, expect, it } from 'vitest';
import { pickLanAddress, type IfaceAddr } from '../src/server.js';

// Shorthand: a non-internal IPv4 entry.
const v4 = (address: string): IfaceAddr => ({ family: 'IPv4', internal: false, address });
const loop = (): IfaceAddr => ({ family: 'IPv4', internal: true, address: '127.0.0.1' });

describe('pickLanAddress — prefers the address a phone on the Wi-Fi can reach', () => {
  it('returns the real LAN IP, not the Tailscale CGNAT one — even when Tailscale enumerates first', () => {
    // The exact "Go Live" bug: Windows listed the Tailscale adapter (100.x) before
    // Wi-Fi, so the first-non-internal pick returned an address phones can't route to.
    const ifaces: Record<string, IfaceAddr[]> = {
      Tailscale: [v4('100.64.0.10')],
      'Wi-Fi': [v4('192.168.1.50')],
      Loopback: [loop()],
    };
    expect(pickLanAddress(ifaces)).toBe('192.168.1.50');
  });

  it('skips a virtual adapter that happens to have a 192.168 address', () => {
    const ifaces: Record<string, IfaceAddr[]> = {
      'vEthernet (WSL)': [v4('192.168.240.1')], // virtual switch — not the Wi-Fi
      'Wi-Fi': [v4('192.168.1.42')],
    };
    expect(pickLanAddress(ifaces)).toBe('192.168.1.42');
  });

  it('prefers 192.168 over a 10.x adapter', () => {
    const ifaces: Record<string, IfaceAddr[]> = {
      Ethernet: [v4('10.5.5.5')],
      'Wi-Fi': [v4('192.168.0.10')],
    };
    expect(pickLanAddress(ifaces)).toBe('192.168.0.10');
  });

  it('falls back to the Tailscale IP only when there is no real LAN', () => {
    // Off-LAN (e.g. tethered + tailnet): the 100.x address is still better than
    // null — tailnet devices can reach it.
    const ifaces: Record<string, IfaceAddr[]> = {
      Tailscale: [v4('100.64.0.20')],
      Loopback: [loop()],
    };
    expect(pickLanAddress(ifaces)).toBe('100.64.0.20');
  });

  it('excludes link-local APIPA (169.254) outright', () => {
    const ifaces: Record<string, IfaceAddr[]> = {
      'Wi-Fi': [v4('169.254.13.7')], // no DHCP lease — unreachable
      Loopback: [loop()],
    };
    expect(pickLanAddress(ifaces)).toBeNull();
  });

  it('returns null when there is no non-internal IPv4', () => {
    expect(pickLanAddress({ Loopback: [loop()] })).toBeNull();
    expect(pickLanAddress({})).toBeNull();
  });

  it('handles the numeric family form (family === 4)', () => {
    const ifaces: Record<string, IfaceAddr[]> = {
      'Wi-Fi': [{ family: 4, internal: false, address: '192.168.5.5' }],
    };
    expect(pickLanAddress(ifaces)).toBe('192.168.5.5');
  });
});
