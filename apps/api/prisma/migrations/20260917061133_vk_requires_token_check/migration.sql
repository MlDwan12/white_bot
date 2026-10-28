-- Prisma's schema language has no CHECK-constraint support, so this is
-- hand-written: only VK groups carry their own token (MAX bots authenticate
-- with one bot-wide token, not per-chat) — enforce that at the DB level so a
-- future insert/update outside GroupsService can't silently leave a VK group
-- without a usable token.
ALTER TABLE "Group" ADD CONSTRAINT "vk_group_requires_token" CHECK (
  "platform" <> 'vk' OR ("accessTokenEncrypted" IS NOT NULL AND "tokenMask" IS NOT NULL)
);
