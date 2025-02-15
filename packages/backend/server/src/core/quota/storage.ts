import { Injectable, NotFoundException } from '@nestjs/common';

import { FeatureService, FeatureType } from '../features';
import { WorkspaceBlobStorage } from '../storage';
import { PermissionService } from '../workspaces/permission';
import { OneGB } from './constant';
import { QuotaService } from './service';
import { formatSize, QuotaQueryType } from './types';

@Injectable()
export class QuotaManagementService {
  constructor(
    private readonly feature: FeatureService,
    private readonly quota: QuotaService,
    private readonly permissions: PermissionService,
    private readonly storage: WorkspaceBlobStorage
  ) {}

  async getUserQuota(userId: string) {
    const quota = await this.quota.getUserQuota(userId);

    return {
      name: quota.feature.name,
      reason: quota.reason,
      createAt: quota.createdAt,
      expiredAt: quota.expiredAt,
      blobLimit: quota.feature.blobLimit,
      storageQuota: quota.feature.storageQuota,
      historyPeriod: quota.feature.historyPeriod,
      memberLimit: quota.feature.memberLimit,
    };
  }

  // TODO: lazy calc, need to be optimized with cache
  async getUserUsage(userId: string) {
    const workspaces = await this.permissions.getOwnedWorkspaces(userId);

    const sizes = await Promise.all(
      workspaces.map(workspace => this.storage.totalSize(workspace))
    );

    return sizes.reduce((total, size) => total + size, 0);
  }

  // get workspace's owner quota and total size of used
  // quota was apply to owner's account
  async getWorkspaceUsage(workspaceId: string): Promise<QuotaQueryType> {
    const { user: owner } =
      await this.permissions.getWorkspaceOwner(workspaceId);
    if (!owner) throw new NotFoundException('Workspace owner not found');
    const {
      feature: {
        name,
        blobLimit,
        historyPeriod,
        memberLimit,
        storageQuota,
        humanReadable,
      },
    } = await this.quota.getUserQuota(owner.id);
    // get all workspaces size of owner used
    const usedSize = await this.getUserUsage(owner.id);

    const quota = {
      name,
      blobLimit,
      historyPeriod,
      memberLimit,
      storageQuota,
      humanReadable,
      usedSize,
    };

    // relax restrictions if workspace has unlimited feature
    // todo(@darkskygit): need a mechanism to allow feature as a middleware to edit quota
    const unlimited = await this.feature.hasWorkspaceFeature(
      workspaceId,
      FeatureType.UnlimitedWorkspace
    );
    if (unlimited) {
      return this.mergeUnlimitedQuota(quota);
    }

    return quota;
  }

  private mergeUnlimitedQuota(orig: QuotaQueryType) {
    return {
      ...orig,
      storageQuota: 1000 * OneGB,
      memberLimit: 1000,
      humanReadable: {
        ...orig.humanReadable,
        name: 'Unlimited',
        storageQuota: formatSize(1000 * OneGB),
        memberLimit: '1000',
      },
    };
  }

  async checkBlobQuota(workspaceId: string, size: number) {
    const { storageQuota, usedSize } =
      await this.getWorkspaceUsage(workspaceId);

    return storageQuota - (size + usedSize);
  }
}
