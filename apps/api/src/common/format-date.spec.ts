import { formatDate } from './format-date';

describe('formatDate', () => {
  it('formats a date the way a Russian reader expects', () => {
    expect(formatDate(new Date('2026-09-20T08:05:00Z'))).toMatch(
      /^20\.09\.2026/,
    );
  });
});
