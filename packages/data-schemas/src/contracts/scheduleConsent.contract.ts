/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `ScheduleConsentStore` contract (`~/ports/scheduleConsent`), ported from
 * `methods/scheduleConsent.spec.ts`, which stays unchanged: the delegated MCP consent stored on a
 * schedule (`schedules.mcpConsent`, a `json` value on PostgreSQL queried by path). The schedule is
 * addressed by its identity (schedule, owner, tenant); one being deleted, erased or suspended for
 * deletion reads as absent. The confirmation compare-and-set (config revision, a missing legacy
 * revision read as 0, the expected consent revision or none, the root agent; one winner among
 * concurrent confirmations; the enrollment binding checked and expired consents refused before
 * the write), the revocation under a fresh revision, and the admission (`$elemMatch` on the
 * consent id and revision, `$nor` over revoked or expired consents, the enabled flag unless
 * waived, the deadline never extended, the update time untouched). The consent carried through an
 * activation edit (`updateScheduleById` with `preserveMCPConsentRevision`, on the schedule store of
 * the same unit) is pinned here too.
 *
 * Not here (it stays in the method spec): the operator-shape spy (classic update operators only).
 * Schedules are created through the schedule store, a stored consent of an unknown version raw.
 * Nothing here may import `mongoose` or the MongoDB driver.
 */
import { scheduledMCPEnrollmentSchema } from 'librechat-data-provider';
import type { ScheduledMCPIdentity, ScheduledMCPEnrollment } from 'librechat-data-provider';
import type { ContractHarness, RawRecord } from './harness';
import type { ScheduleStoreData } from '~/ports/schedule';
import { readRawWhere, timeOf, useContractHarness } from './support';

export function describeScheduleConsentContract(harness: ContractHarness): void {
  describe(`ScheduleConsentStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const stores = () => harness.createStores();
    const consents = () => stores().scheduleConsents;
    const newId = () => harness.ids.generate();
    let owner: string;
    let identity: ScheduledMCPIdentity;

    /** An enrollment at `revision` for {@link identity}, valid for ten minutes. */
    const enrollment = (
      revision = 'grant-1',
      overrides: Partial<ScheduledMCPEnrollment> = {},
    ): ScheduledMCPEnrollment => ({
      version: 1,
      revision,
      scheduleRevision: 0,
      consents: [
        {
          id: 'consent-1',
          revision,
          identity,
          resource: {
            serverName: 'warehouse',
            url: 'https://warehouse.example/mcp',
            configurationRevision: 'config-1',
            credentialMode: 'resource_bearer',
            issuer: 'https://issuer.example/',
            audience: 'warehouse',
            scopes: ['read'],
          },
          permittedTools: [{ agentId: 'root', tools: ['query'] }],
          policyRevision: 'policy-1',
          grantedAtMs: Date.now() - 1000,
          absoluteExpiresAtMs: Date.now() + 600_000,
          revokedAtMs: null,
        },
      ],
      ...overrides,
    });
    const scheduleData = (overrides: ScheduleStoreData = {}): ScheduleStoreData => ({
      id: identity.scheduleId,
      user: owner,
      tenantId: 'tenant-1',
      agent_id: 'root',
      name: 'Digest',
      prompt: 'Read',
      cadence: { frequency: 'hourly', minute: 0, hour: 1 },
      timezone: 'UTC',
      enabled: true,
      ...overrides,
    });
    const confirm = (expectedRevision: string | null = null, grant = enrollment()) =>
      consents().confirmScheduleMCPConsent({
        identity,
        expectedConfigRevision: 0,
        expectedRevision,
        enrollment: grant,
      });
    const admit = (revision = 'grant-1', extra: { requireEnabled?: boolean } = {}) =>
      consents().admitScheduleMCPConsent({
        identity,
        revision,
        expectedConfigRevision: 0,
        consentId: 'consent-1',
        ...extra,
      });
    const stored = async (): Promise<RawRecord> =>
      (await readRawWhere(harness, 'schedules', { id: identity.scheduleId }))[0];

    beforeEach(async () => {
      owner = newId();
      identity = {
        scheduleId: 'schedule-1',
        ownerId: owner,
        tenantId: 'tenant-1',
        agentId: 'root',
        invocationMode: 'delegated',
      };
    });

    describe('readScheduleMCPConsent', () => {
      it('reads a legacy schedule as unenrolled and compatible, with its activation state', async () => {
        await stores().schedules.createSchedule(scheduleData());
        expect(await consents().readScheduleMCPConsent(identity)).toEqual({
          agentId: 'root',
          enabled: true,
          configRevision: 0,
          enrollment: null,
          compatible: true,
        });
      });

      it('reads a stored consent, also through another set of stores', async () => {
        await stores().schedules.createSchedule(scheduleData());
        const grant = enrollment();
        expect(await confirm(null, grant)).toBe(true);
        const read = await harness.createStores().scheduleConsents.readScheduleMCPConsent(identity);
        expect(read).toMatchObject({ agentId: 'root', enabled: true, compatible: true });
        expect(read?.enrollment).toEqual(grant);
      });

      it('reads a configuration revision the record does not carry as 0', async () => {
        await harness.seedRaw('schedules', [
          {
            _id: newId(),
            id: identity.scheduleId,
            user: owner,
            tenantId: 'tenant-1',
            agent_id: 'root',
            name: 'Legacy',
            prompt: 'Read',
            cadence: { frequency: 'hourly', minute: 0, hour: 1 },
            timezone: 'UTC',
            target: 'new',
            enabled: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]);
        expect(await consents().readScheduleMCPConsent(identity)).toMatchObject({
          configRevision: 0,
          enabled: false,
          enrollment: null,
        });
        expect(await confirm()).toBe(true);
      });

      it('fails closed on an unknown stored version, which nothing overwrites', async () => {
        await harness.seedRaw('schedules', [
          {
            _id: newId(),
            id: identity.scheduleId,
            user: owner,
            tenantId: 'tenant-1',
            agent_id: 'root',
            name: 'Future',
            prompt: 'Read',
            cadence: { frequency: 'hourly', minute: 0, hour: 1 },
            timezone: 'UTC',
            target: 'new',
            enabled: true,
            configRevision: 0,
            deleting: false,
            mcpConsent: { version: 2, revision: 'future' },
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]);
        expect(await consents().readScheduleMCPConsent(identity)).toMatchObject({
          enrollment: null,
          compatible: false,
        });
        expect(await confirm()).toBe(false);
        expect(await admit('future')).toBe(false);
        expect(await consents().revokeScheduleMCPConsent(identity, 'future')).toBe(false);
        expect((await stored()).mcpConsent).toEqual({ version: 2, revision: 'future' });
      });

      it('isolates owners and tenants even for an identical schedule id', async () => {
        await stores().schedules.createSchedule(scheduleData());
        await confirm();
        for (const wrong of [
          { ...identity, ownerId: newId() },
          { ...identity, tenantId: 'tenant-2' },
          { ...identity, tenantId: null },
          { ...identity, scheduleId: 'schedule-2' },
        ]) {
          expect(await consents().readScheduleMCPConsent(wrong)).toBeNull();
          expect(await consents().revokeScheduleMCPConsent(wrong, 'grant-1')).toBe(false);
          expect(
            await consents().admitScheduleMCPConsent({
              identity: wrong,
              revision: 'grant-1',
              expectedConfigRevision: 0,
              consentId: 'consent-1',
            }),
          ).toBe(false);
        }
      });

      it.each([
        ['being deleted', { deleting: true }],
        ['erased', { erased: true }],
        ['suspended for deletion', { deletionSuspension: { token: 'attempt-1', enabled: true } }],
      ] as const)(
        'reads a schedule %s as absent and denies its grants and admission',
        async (_name, state) => {
          await stores().schedules.createSchedule(
            scheduleData({ ...state, mcpConsent: enrollment() }),
          );
          expect(await consents().readScheduleMCPConsent(identity)).toBeNull();
          expect(await admit()).toBe(false);
          expect(await consents().revokeScheduleMCPConsent(identity, 'grant-1')).toBe(false);
          expect(await confirm('grant-1', enrollment('grant-2'))).toBe(false);
        },
      );
    });

    describe('confirmScheduleMCPConsent', () => {
      beforeEach(async () => {
        await stores().schedules.createSchedule(scheduleData());
      });

      it('stores the parsed enrollment, keeping the key order the parse writes', async () => {
        const grant = enrollment();
        expect(await confirm(null, grant)).toBe(true);
        const consent = (await stored()).mcpConsent as ScheduledMCPEnrollment;
        const parsed = scheduledMCPEnrollmentSchema.parse(grant);
        expect(consent).toEqual(grant);
        expect(Object.keys(consent)).toEqual(Object.keys(parsed));
        expect(Object.keys(consent.consents[0])).toEqual(Object.keys(parsed.consents[0]));
        expect(Object.keys(consent.consents[0].resource)).toEqual(
          Object.keys(parsed.consents[0].resource),
        );
      });

      it('has one winner among concurrent confirmations', async () => {
        const results = await Promise.all(
          Array.from({ length: 6 }, (_, index) => confirm(null, enrollment(`grant-${index}`))),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
        const read = await consents().readScheduleMCPConsent(identity);
        expect(results[Number(read?.enrollment?.revision.slice('grant-'.length))]).toBe(true);
      });

      it('replaces a consent only at the expected revision', async () => {
        await confirm();
        expect(await confirm(null, enrollment('grant-2'))).toBe(false);
        expect(await confirm('grant-0', enrollment('grant-2'))).toBe(false);
        expect(await confirm('grant-1', enrollment('grant-2'))).toBe(true);
        expect((await consents().readScheduleMCPConsent(identity))?.enrollment?.revision).toBe(
          'grant-2',
        );
      });

      it('refuses an expired consent before writing', async () => {
        const grant = enrollment();
        grant.consents[0].grantedAtMs = Date.now() - 5000;
        grant.consents[0].absoluteExpiresAtMs = Date.now() - 1000;
        expect(await confirm(null, grant)).toBe(false);
        expect(await stored()).not.toHaveProperty('mcpConsent');
      });

      it('throws on an enrollment bound to another schedule, or bearing credentials', async () => {
        const bad = enrollment();
        bad.consents[0].identity = { ...identity, agentId: 'changed' };
        await expect(confirm(null, bad)).rejects.toThrow('binding');
        await expect(confirm(null, enrollment('grant-1', { scheduleRevision: 1 }))).rejects.toThrow(
          'binding',
        );
        const revoked = enrollment();
        revoked.consents[0].revokedAtMs = Date.now();
        await expect(confirm(null, revoked)).rejects.toThrow('binding');
        const secret = enrollment();
        Object.assign(secret.consents[0].resource, { accessToken: 'do-not-store' });
        await expect(confirm(null, secret)).rejects.toThrow();
        expect(await stored()).not.toHaveProperty('mcpConsent');
      });

      it('refuses after a root-agent change or a config edit, which revocation still reaches', async () => {
        await confirm();
        await stores().schedules.updateScheduleById(identity.scheduleId, owner, {
          agent_id: 'other',
        });
        expect(await admit()).toBe(false);
        expect(await confirm('grant-1', enrollment('fresh'))).toBe(false);
        expect(
          await consents().revokeScheduleMCPConsent({ ...identity, agentId: 'other' }, 'grant-1'),
        ).toBe(true);
      });
    });

    describe('revokeScheduleMCPConsent', () => {
      beforeEach(async () => {
        await stores().schedules.createSchedule(scheduleData());
      });

      it('marks every consent revoked under a fresh revision, fencing use and stale confirmations', async () => {
        await confirm();
        const before = Date.now();
        expect(await consents().revokeScheduleMCPConsent(identity, 'grant-1')).toBe(true);
        const read = await consents().readScheduleMCPConsent(identity);
        expect(read?.enrollment?.revision).not.toBe('grant-1');
        expect(read?.enrollment?.consents[0].revision).toBe(read?.enrollment?.revision);
        expect(read?.enrollment?.consents[0].revokedAtMs).toBeGreaterThanOrEqual(before);
        expect(await admit()).toBe(false);
        expect(await admit(read!.enrollment!.revision)).toBe(false);
        expect(await confirm('grant-1', enrollment('grant-2'))).toBe(false);
        expect(await confirm(read!.enrollment!.revision, enrollment('fresh-grant'))).toBe(true);
        expect(await admit('fresh-grant')).toBe(true);
      });

      it('refuses a stale revision and a schedule without a consent', async () => {
        expect(await consents().revokeScheduleMCPConsent(identity, 'grant-1')).toBe(false);
        await confirm();
        expect(await consents().revokeScheduleMCPConsent(identity, 'grant-0')).toBe(false);
        expect(
          (await consents().readScheduleMCPConsent(identity))?.enrollment?.consents[0],
        ).toMatchObject({ revokedAtMs: null });
      });

      it('linearizes against a racing admission', async () => {
        await confirm();
        await Promise.all([admit(), consents().revokeScheduleMCPConsent(identity, 'grant-1')]);
        expect(await admit()).toBe(false);
      });
    });

    describe('admitScheduleMCPConsent', () => {
      it('admits repeatedly without extending the deadline or the update time', async () => {
        await stores().schedules.createSchedule(scheduleData());
        const grant = enrollment();
        await confirm(null, grant);
        const before = await stored();
        expect(await admit()).toBe(true);
        expect(await admit()).toBe(true);
        const after = await stored();
        expect(after.mcpConsent).toEqual(grant);
        expect(timeOf(after.updatedAt)).toBe(timeOf(before.updatedAt));
      });

      it('admits a disabled schedule only when enabled is not required', async () => {
        await stores().schedules.createSchedule(scheduleData({ enabled: false }));
        await confirm();
        expect(await admit()).toBe(false);
        expect(await admit('grant-1', { requireEnabled: false })).toBe(true);
        await consents().revokeScheduleMCPConsent(identity, 'grant-1');
        expect(await admit('grant-1', { requireEnabled: false })).toBe(false);
      });

      it('refuses an expired consent, another consent id and another config revision', async () => {
        const expired = enrollment();
        expired.consents[0].grantedAtMs = Date.now() - 5000;
        expired.consents[0].absoluteExpiresAtMs = Date.now() - 1;
        await stores().schedules.createSchedule(scheduleData({ mcpConsent: expired }));
        expect(await admit()).toBe(false);
        await stores().schedules.deleteSchedulesByUser(owner);

        await stores().schedules.createSchedule(scheduleData());
        await confirm();
        expect(
          await consents().admitScheduleMCPConsent({
            identity,
            revision: 'grant-1',
            expectedConfigRevision: 0,
            consentId: 'consent-2',
          }),
        ).toBe(false);
        expect(
          await consents().admitScheduleMCPConsent({
            identity,
            revision: 'grant-1',
            expectedConfigRevision: 1,
            consentId: 'consent-1',
          }),
        ).toBe(false);
        expect(await admit()).toBe(true);
      });

      it('refuses when any consent of the enrollment is revoked or expired', async () => {
        const grant = enrollment();
        const [first] = grant.consents;
        grant.consents.push({
          ...first,
          id: 'consent-2',
          grantedAtMs: Date.now() - 5000,
          absoluteExpiresAtMs: Date.now() - 1,
        });
        await stores().schedules.createSchedule(scheduleData({ mcpConsent: grant }));
        expect(await admit()).toBe(false);
      });
    });

    describe('consent carried through an activation edit', () => {
      beforeEach(async () => {
        await stores().schedules.createSchedule(scheduleData());
        await confirm();
      });

      it('carries the consent to the next revision without extending its expiry', async () => {
        const before = await consents().readScheduleMCPConsent(identity);
        const updated = await stores().schedules.updateScheduleById(
          identity.scheduleId,
          owner,
          { enabled: false },
          undefined,
          { expectedConfigRevision: 0, preserveMCPConsentRevision: 'grant-1' },
        );
        expect(updated?.mcpConsent?.scheduleRevision).toBe(1);
        const after = await consents().readScheduleMCPConsent(identity);
        expect(after?.enrollment?.consents).toEqual(before?.enrollment?.consents);
        expect(after).toMatchObject({ configRevision: 1, enabled: false });
        expect(
          await consents().admitScheduleMCPConsent({
            identity,
            revision: 'grant-1',
            consentId: 'consent-1',
            expectedConfigRevision: 1,
            requireEnabled: false,
          }),
        ).toBe(true);
      });

      it('does not revive a consent through an edit after a content change', async () => {
        await stores().schedules.updateScheduleById(
          identity.scheduleId,
          owner,
          { prompt: 'Changed' },
          undefined,
          { expectedConfigRevision: 0 },
        );
        expect(
          await stores().schedules.updateScheduleById(
            identity.scheduleId,
            owner,
            { enabled: true },
            undefined,
            { expectedConfigRevision: 1, preserveMCPConsentRevision: 'grant-1' },
          ),
        ).toBeNull();
      });

      it('never overwrites a revocation racing the activation edit', async () => {
        await consents().revokeScheduleMCPConsent(identity, 'grant-1');
        expect(
          await stores().schedules.updateScheduleById(
            identity.scheduleId,
            owner,
            { enabled: false },
            undefined,
            { expectedConfigRevision: 0, preserveMCPConsentRevision: 'grant-1' },
          ),
        ).toBeNull();
        expect(
          (await consents().readScheduleMCPConsent(identity))?.enrollment?.consents[0].revokedAtMs,
        ).not.toBeNull();
      });

      it('files the schedule under a project only while it already is', async () => {
        const options = { expectedConfigRevision: 0, preserveMCPConsentRevision: 'grant-1' };
        expect(
          await stores().schedules.updateScheduleById(
            identity.scheduleId,
            owner,
            { chatProjectId: 'project-1' },
            undefined,
            options,
          ),
        ).toBeNull();
        await stores().schedules.persistResolvedProject(identity.scheduleId, 'project-1');
        expect(
          (
            await stores().schedules.updateScheduleById(
              identity.scheduleId,
              owner,
              { chatProjectId: 'project-1', enabled: false },
              undefined,
              options,
            )
          )?.mcpConsent?.scheduleRevision,
        ).toBe(1);
      });
    });
  });
}
