import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminUser } from '../generated/prisma/client';

/**
 * Maps a MAX sender onto an AdminUser via `maxUserId` — the same row the web
 * panel authenticates, so a command from chat and a click in the UI share one
 * `actorId` for auditing.
 *
 * This is deliberately identification only, not authorization: the permission
 * matrix (roles, `extraPermissions`) lands in Step 9, and every consumer here
 * currently means "is this a known admin at all". Once the matrix exists, the
 * per-permission check slots in on top of this lookup without changing it.
 */
@Injectable()
export class MaxAdminResolver {
  constructor(private readonly prisma: PrismaService) {}

  /** Null for anyone we don't know — callers must stay silent rather than reply. */
  async findByMaxUserId(maxUserId: number): Promise<AdminUser | null> {
    return this.prisma.adminUser.findUnique({
      where: { maxUserId: String(maxUserId) },
    });
  }

  /**
   * Admins reachable over MAX, for proactive notifications (a new group
   * pending review, later the delivery/alert summaries from PLAN.md).
   * An AdminUser without `maxUserId` has simply never linked their MAX
   * account and can only be reached in the web panel.
   */
  async listNotifiableAdmins(): Promise<(AdminUser & { maxUserId: string })[]> {
    const admins = await this.prisma.adminUser.findMany({
      where: { maxUserId: { not: null } },
      orderBy: { createdAt: 'asc' },
    });
    return admins as (AdminUser & { maxUserId: string })[];
  }
}
