import { ValidationPipe } from '@nestjs/common';
import { UpdateTemplateDto } from './create-template.dto';

/**
 * Exercised through the *real* pipe, with the same options `main.ts` installs.
 * The bug these cover was invisible to a unit test of the service: it lived in
 * the gap between `@IsOptional()` (which skips `null` as well as `undefined`)
 * and `whitelist: true` (which keeps the key because the property is
 * decorated), so an explicit `null` reached Prisma.
 */
const pipe = new ValidationPipe({ whitelist: true, transform: true });
const meta = { type: 'body' as const, metatype: UpdateTemplateDto };

const accepts = (body: object) => pipe.transform(body, meta);

describe('UpdateTemplateDto', () => {
  it.each([
    ['recurrenceRule', { recurrenceRule: null }],
    ['text', { text: null }],
    ['timezone', { timezone: null }],
    ['groupIds', { groupIds: null }],
    ['attachmentIds', { attachmentIds: null }],
  ])('rejects an explicit null for %s', async (_field, body) => {
    await expect(accepts(body)).rejects.toBeDefined();
  });

  it('still allows null on the overrides, where it means "clear it"', async () => {
    await expect(accepts({ vkTextOverride: null })).resolves.toMatchObject({
      vkTextOverride: null,
    });
    await expect(accepts({ maxTextOverride: null })).resolves.toMatchObject({
      maxTextOverride: null,
    });
  });

  it('accepts an ordinary edit', async () => {
    await expect(
      accepts({ text: 'новый текст', recurrenceRule: '0 10 * * *' }),
    ).resolves.toEqual({ text: 'новый текст', recurrenceRule: '0 10 * * *' });
  });

  it('still drops unknown properties', async () => {
    await expect(accepts({ text: 'x', status: 'sent' })).resolves.toEqual({
      text: 'x',
    });
  });
});
