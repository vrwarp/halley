import type { AllowlistEntryDto, EditorSessionDto } from '@halley/shared';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { OptimizeAstroPanel } from '../components/OptimizeAstroPanel.js';

interface Props {
  onBack: () => void;
  onOpenSession: (id: string) => void;
  focusOptimize?: boolean;
}

export function AdminPage({ onBack, onOpenSession, focusOptimize }: Props) {
  const [allowlist, setAllowlist] = useState<AllowlistEntryDto[]>([]);
  const [capInput, setCapInput] = useState('10');
  const [todaySpend, setTodaySpend] = useState<
    Array<{
      userId: string;
      email: string;
      name: string;
      isAdmin: number;
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
      extraGrantedUsd: number;
    }>
  >([]);
  const [spendByPurpose, setSpendByPurpose] = useState<
    Array<{ purpose: string; requestCount: number; costUsd: number }>
  >([]);
  const [sessions, setSessions] = useState<EditorSessionDto[]>([]);
  const [kind, setKind] = useState<'email' | 'domain'>('email');
  const [val, setVal] = useState('');

  const load = async () => {
    const data = await api.adminOverview();
    setAllowlist(data.allowlist);
    setCapInput(String(data.dailyCapUsd));
    setTodaySpend(data.todaySpend);
    setSpendByPurpose(data.spendByPurpose ?? []);
    setSessions(data.sessions);
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="min-h-screen bg-[#FAF9F7]">
      <header className="border-b border-[#E7E5E4] bg-white">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-6">
          <button
            type="button"
            onClick={onBack}
            className="rounded-lg p-1.5 text-stone-500 hover:bg-stone-100 hover:text-stone-900"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h1 className="text-sm font-semibold text-stone-900">
            Admin, Readiness &amp; Access Control
          </h1>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8 space-y-8">
        <OptimizeAstroPanel
          onOpenSession={onOpenSession}
          onSpendChanged={() => void load()}
          autoFocus={focusOptimize}
        />

        {/* Allowlist */}
        <section className="rounded-2xl border border-[#E7E5E4] bg-white p-6">
          <h2 className="text-base font-semibold text-stone-900">Allowed Editors</h2>
          <p className="mt-1 text-xs text-stone-500">
            Anyone signing in with Google must match an allowed email or workspace domain.
          </p>

          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!val.trim()) return;
              await api.addAllowlist(kind, val.trim());
              setVal('');
              await load();
            }}
            className="mt-4 flex flex-wrap gap-2"
          >
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as 'email' | 'domain')}
              className="rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm"
            >
              <option value="email">Email</option>
              <option value="domain">Google Domain</option>
            </select>
            <input
              type="text"
              value={val}
              onChange={(e) => setVal(e.target.value)}
              placeholder={kind === 'email' ? 'editor@thecrossing.website' : 'thecrossing.website'}
              className="flex-1 min-w-[220px] rounded-xl border border-stone-300 bg-[#FAF9F7] px-3.5 py-2 text-sm outline-none focus:border-amber-600 focus:bg-white"
            />
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 rounded-xl bg-stone-900 px-4 py-2 text-sm font-semibold text-white hover:bg-stone-800"
            >
              <Plus className="h-4 w-4" /> Add
            </button>
          </form>

          <div className="mt-4 divide-y divide-stone-100 rounded-xl border border-stone-200">
            {allowlist.map((entry) => (
              <div key={entry.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                <div className="flex items-center gap-2.5">
                  <span className="rounded bg-stone-100 px-2 py-0.5 text-[11px] font-medium uppercase text-stone-600">
                    {entry.kind}
                  </span>
                  <span className="font-medium text-stone-800">{entry.value}</span>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    await api.removeAllowlist(entry.id);
                    await load();
                  }}
                  className="rounded p-1 text-stone-400 hover:bg-stone-100 hover:text-red-600"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </section>

        {/* Daily AI Budget */}
        <section className="rounded-2xl border border-[#E7E5E4] bg-white p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-stone-900">Daily AI Spend &amp; Budget</h2>
              <p className="mt-1 text-xs text-stone-500">
                Per-editor daily cap (USD). Grant extra budget anytime if someone is mid-project.
              </p>
            </div>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                await api.setDailyCap(Number(capInput));
                await load();
              }}
              className="flex items-center gap-2"
            >
              <span className="text-xs text-stone-500">Default cap ($/day):</span>
              <input
                type="number"
                step="0.5"
                min="0"
                value={capInput}
                onChange={(e) => setCapInput(e.target.value)}
                className="w-20 rounded-lg border border-stone-300 px-2.5 py-1 text-sm"
              />
              <button
                type="submit"
                className="rounded-lg bg-stone-900 px-3 py-1 text-xs font-semibold text-white"
              >
                Save
              </button>
            </form>
          </div>

          <div className="mt-4 divide-y divide-stone-100 rounded-xl border border-stone-200">
            {todaySpend.map((u) => (
              <div key={u.userId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <p className="font-medium text-stone-900 break-words">
                    {u.name} <span className="text-xs text-stone-400">({u.email})</span>
                  </p>
                  <p className="text-xs text-stone-500">
                    Today: ${u.costUsd.toFixed(3)} · Extra granted: ${u.extraGrantedUsd.toFixed(2)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    await api.grantExtra(u.userId, 10);
                    await load();
                  }}
                  className="min-h-[38px] shrink-0 rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-800 hover:bg-stone-50"
                >
                  Grant +$10 today
                </button>
              </div>
            ))}
          </div>
          {spendByPurpose.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {spendByPurpose.map((p) => (
                <span
                  key={p.purpose}
                  className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-1.5 text-xs text-stone-700"
                >
                  <strong className="capitalize">{p.purpose}</strong>: ${p.costUsd.toFixed(3)} (
                  {p.requestCount} req{p.requestCount === 1 ? '' : 's'})
                </span>
              ))}
            </div>
          )}
        </section>

        {/* All Sessions */}
        <section className="rounded-2xl border border-[#E7E5E4] bg-white p-4 sm:p-6">
          <h2 className="text-base font-semibold text-stone-900">All Sessions ({sessions.length})</h2>
          <div className="mt-4 divide-y divide-stone-100 rounded-xl border border-stone-200">
            {sessions.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <button
                    type="button"
                    onClick={() => onOpenSession(s.id)}
                    className="text-left font-medium text-stone-900 hover:text-amber-700"
                  >
                    {s.title}
                  </button>
                  <p className="text-xs text-stone-500 break-all">
                    {s.ownerName} · {s.status} · {s.workingBranch}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {s.status === 'running' && (
                    <button
                      type="button"
                      onClick={async () => {
                        await api.sleepSession(s.id);
                        await load();
                      }}
                      className="min-h-[36px] rounded-lg border border-stone-200 px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50"
                    >
                      Sleep
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={async () => {
                      await api.deleteSession(s.id);
                      await load();
                    }}
                    className="flex h-9 w-9 items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-red-600"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
