import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Lesson } from '../core/models.ts';
import { parseIsoTime } from '../core/invariants.ts';
import { parseResearchReport, type ResearchReport } from '../learning/research.ts';

const ID = /^[a-zA-Z0-9._-]{1,64}$/;
type Review = Readonly<{
  reportId: string;
  status: 'APPROVED' | 'REJECTED';
  reviewerId: string;
  reviewedAt: string;
}>;

function safeId(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('Invalid journal ID');
  return value;
}
function parseReview(value: unknown): Review {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid review');
  const raw = value as Record<string, unknown>;
  const keys = ['reportId', 'status', 'reviewerId', 'reviewedAt'];
  if (Object.keys(raw).length !== keys.length || keys.some((key) => !Object.hasOwn(raw, key)) ||
      (raw.status !== 'APPROVED' && raw.status !== 'REJECTED')) throw new Error('Invalid review');
  return Object.freeze({ reportId: safeId(raw.reportId), status: raw.status,
    reviewerId: safeId(raw.reviewerId), reviewedAt: parseIsoTime(raw.reviewedAt) });
}

// Exclusive, immutable fixture files give an auditable local proposal/review
// history. A corrupt or partial file fails closed on read; this is not a
// concurrent production position ledger or an authentication system.
export class FileLessonJournal {
  private readonly directory: string;

  constructor(directory: string) {
    if (typeof directory !== 'string' || directory.length === 0) throw new Error('Invalid journal path');
    this.directory = directory;
  }

  private path(kind: 'proposal' | 'review', id: string): string {
    return join(this.directory, `${kind}-${safeId(id)}.json`);
  }

  private async read(path: string): Promise<unknown> {
    const info = await stat(path);
    if (!info.isFile() || info.size < 1 || info.size > 256 * 1024) {
      throw new Error('Invalid journal file');
    }
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  }

  async appendProposal(value: ResearchReport): Promise<void> {
    const report = parseResearchReport(value);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(this.path('proposal', report.id), `${JSON.stringify(report)}\n`,
      { flag: 'wx', mode: 0o600 });
  }

  async getProposal(id: string): Promise<ResearchReport> {
    const report = parseResearchReport(await this.read(this.path('proposal', id)));
    if (report.id !== id) throw new Error('Mismatched journal ID');
    return report;
  }

  // Only a trusted operator workflow should call this method. The Researcher
  // receives no journal reference and cannot promote its own proposal.
  async recordReview(value: Review): Promise<void> {
    const review = parseReview(value);
    const report = await this.getProposal(review.reportId);
    if (Date.parse(review.reviewedAt) < Date.parse(report.lesson.proposedAt)) {
      throw new Error('Review precedes proposal');
    }
    await writeFile(this.path('review', review.reportId), `${JSON.stringify(review)}\n`,
      { flag: 'wx', mode: 0o600 });
  }

  async approvedLessons(): Promise<readonly Lesson[]> {
    let entries: string[];
    try { entries = await readdir(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze([]);
      throw error;
    }
    const lessons: Lesson[] = [];
    for (const entry of entries.filter((name) => /^proposal-[a-zA-Z0-9._-]{1,64}\.json$/.test(name)).sort()) {
      const id = entry.slice('proposal-'.length, -'.json'.length);
      const report = await this.getProposal(id);
      let review: Review;
      try { review = parseReview(await this.read(this.path('review', id))); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (review.reportId !== id || Date.parse(review.reviewedAt) < Date.parse(report.lesson.proposedAt)) {
        throw new Error('Invalid journal review');
      }
      if (review.status === 'APPROVED') {
        lessons.push(Object.freeze({ ...report.lesson, version: 2, status: 'APPROVED' }));
      }
    }
    return Object.freeze(lessons);
  }
}
