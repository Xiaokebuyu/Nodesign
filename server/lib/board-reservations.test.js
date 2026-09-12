import { describe, it, expect, vi } from 'vitest';
import { reserveSpot, getReservation, takeReservation, updateReservation, reservationsIn, _resetReservations } from './board-reservations.js';

describe('直播板书预留座', () => {
  it('登记 / 按层列出 / 更新高度 / 取走即删', () => {
    _resetReservations();
    reserveSpot('p', 'toolu_1', { x: 10, y: 20, w: 336, h: 120, zone: '', wUnits: 14 });
    reserveSpot('p', 'toolu_2', { x: 0, y: 0, w: 100, h: 50, zone: '素材' });
    expect(reservationsIn('p', '')).toEqual([{ id: 'live:toolu_1', x: 10, y: 20, w: 336, h: 120 }]);
    expect(reservationsIn('p', '素材').map(r => r.id)).toEqual(['live:toolu_2']);
    updateReservation('p', 'toolu_1', { h: 300 });
    expect(getReservation('p', 'toolu_1')).toMatchObject({ h: 300, wUnits: 14 });
    expect(takeReservation('p', 'toolu_1')).toMatchObject({ x: 10, y: 20 });
    expect(getReservation('p', 'toolu_1')).toBeNull();
    expect(reservationsIn('q', '')).toEqual([]);
  });
  it('TTL 兜底：过期的不再算障碍', () => {
    _resetReservations();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    reserveSpot('p', 'toolu_3', { x: 1, y: 1, w: 10, h: 10 });
    Date.now.mockReturnValue(now + 130_000);
    expect(reservationsIn('p', '')).toEqual([]);
    expect(getReservation('p', 'toolu_3')).toBeNull();
    vi.restoreAllMocks();
  });
});
