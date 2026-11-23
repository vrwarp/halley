import type { AllowlistEntryDto, EditorSessionDto } from '@halley/shared';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api.js';

interface Props {
  onBack: () => void;
  onOpenSession: (id: string) => void;
}

export function AdminPage({ onBack, onOpenSession }: Props) {
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
  const [sessions, setSessions] = useState<EditorSessionDto[]>([]);
  const [kind, setKind] = useState<'email' | 'domain'>('email');
  const [val, setVal] = useState('');

  const load = async () => {
    const data = await api.adminOverview();
    setAllowlist(data.allowlist);
    setCapInput(String(data.dailyCapUsd));
    setTodaySpend(data.todaySpend);
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
          <h1 className="text-sm font-semibold text-stone-900">Admin &amp; Access Control</h1>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8 space-y-8">
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
              <div key={u.userId} className="flex items-center justify-between px-4 py-3 text-sm">
                <div>
                  <p className="font-medium text-stone-900">
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
                  className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-800 hover:bg-stone-50"
                >
                  Grant +$10 today
                </button>
              </div>
            ))}
          </div>
        </section>

        {/* All Sessions */}
        <section className="rounded-2xl border border-[#E7E5E4] bg-white p-6">
          <h2 className="text-base font-semibold text-stone-900">All Sessions ({sessions.length})</h2>
          <div className="mt-4 divide-y divide-stone-100 rounded-xl border border-stone-200">
            {sessions.map((s) => (
              <div key={s.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <div>
                  <button
                    type="button"
                    onClick={() => onOpenSession(s.id)}
                    className="font-medium text-stone-900 hover:text-amber-700"
                  >
                    {s.title}
                  </button>
                  <p className="text-xs text-stone-500">
                    {s.ownerName} · {s.status} · {s.workingBranch}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {s.status === 'running' && (
                    <button
                      type="button"
                      onClick={async () => {
                        await api.sleepSession(s.id);
                        await load();
                      }}
                      className="rounded-lg border border-stone-200 px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50"
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
                    className="rounded p-1 text-stone-400 hover:bg-stone-100 hover:text-red-600"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
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
