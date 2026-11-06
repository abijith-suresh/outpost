import { createEffect, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { render } from "solid-js/web";
import {
  ApiError,
  api,
  consumeProof,
  forgetSession,
  type Operation,
  type OperationInput,
  pair,
  type Repository,
  type Settings,
  type Snapshot,
  UnknownOperationFailure,
  type WorkspaceDetail,
} from "./api";
import "./style.css";

function App() {
  const [session, setSession] = createSignal(false),
    [section, setSection] = createSignal<"repositories" | "workspaces" | "settings">(
      "repositories"
    );
  const [snapshot, setSnapshot] = createSignal<Snapshot>(),
    [stale, setStale] = createSignal(""),
    [error, setError] = createSignal("");
  const [detail, setDetail] = createSignal<WorkspaceDetail>(),
    [settings, setSettings] = createSignal<Settings>(),
    [dialog, setDialog] = createSignal("");
  const [workspaceHandle, setWorkspaceHandle] = createSignal(""),
    [readiness, setReadiness] =
      createSignal<Extract<NonNullable<Operation["result"]>, { kind: "workspace-readiness" }>>(),
    [readinessRevision, setReadinessRevision] = createSignal("");
  const [createRepos, setCreateRepos] = createSignal<Repository[]>([]),
    [createSelected, setCreateSelected] = createSignal<string[]>([]),
    [createTicket, setCreateTicket] = createSignal(""),
    [createType, setCreateType] = createSignal("feat"),
    [createTags, setCreateTags] = createSignal(""),
    [createMode, setCreateMode] = createSignal<"base" | "reuse">("base"),
    [createSource, setCreateSource] = createSignal<"" | "local" | "cached-remote" | "fresh-remote">(
      ""
    ),
    [createBase, setCreateBase] = createSignal(""),
    [createRemote, setCreateRemote] = createSignal(""),
    [createBranch, setCreateBranch] = createSignal(""),
    [createRoot, setCreateRoot] = createSignal("");
  const [selected, setSelected] = createSignal(""),
    [name, setName] = createSignal(""),
    [remoteName, setRemoteName] = createSignal(""),
    [path, setPath] = createSignal(""),
    [tags, setTags] = createSignal(""),
    [instructions, setInstructions] = createSignal("");
  const [retained, setRetained] = createSignal(false),
    [operation, setOperation] = createSignal<Operation>(),
    [busy, setBusy] = createSignal(false),
    [menu, setMenu] = createSignal(false);
  const [search, setSearch] = createSignal("");
  const [tagFilter, setTagFilter] = createSignal("");
  const [groupTags, setGroupTags] = createSignal(false);
  const [repoDetail, setRepoDetail] = createSignal("");
  const [repoActions, setRepoActions] = createSignal("");
  const visibleRepositories = () => {
    const terms = tagFilter()
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    const repos = (snapshot()?.repositories ?? []).filter(
      (repo) =>
        repo.retained === retained() &&
        repo.name.toLocaleLowerCase().includes(search().toLocaleLowerCase()) &&
        terms.every((tag) => repo.tags.includes(tag))
    );
    if (!groupTags()) return repos.map((repo) => ({ repo, heading: "" }));
    const groups = new Map<string, typeof repos>();
    for (const repo of repos)
      for (const key of repo.tags.length ? repo.tags.map((tag) => `tag:${tag}`) : ["untagged"])
        groups.set(key, [...(groups.get(key) ?? []), repo]);
    return [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([key, rows]) =>
        rows.map((repo, index) => ({
          repo,
          heading: index === 0 ? (key === "untagged" ? "Untagged" : key.slice(4)) : "",
        }))
      );
  };
  const [fieldErrors, setFieldErrors] = createSignal<{ name?: string; path?: string }>({});
  const [dialogError, setDialogError] = createSignal("");
  let loadedPages = 1;
  const [dialogRevision, setDialogRevision] = createSignal<string>();
  async function copyPath(value: string | undefined) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      setError("Clipboard unavailable. Select the recorded path and copy it manually.");
    }
  }
  let controller: AbortController | undefined;
  let pollTimer: number | undefined;
  let activeInput: OperationInput | undefined;
  let activeRevision = "";
  const message = (e: unknown) => (e instanceof Error ? e.message : "Request failed.");
  async function load(cursor?: string) {
    if (section() === "settings" || !session()) return;
    controller?.abort();
    const c = new AbortController();
    controller = c;
    try {
      let data = await api.snapshot(section() as "repositories" | "workspaces", cursor, c.signal);
      if (!cursor)
        for (let page = 1; page < loadedPages && data.nextCursor; page++) {
          const next = await api.snapshot(
            section() as "repositories" | "workspaces",
            data.nextCursor,
            c.signal
          );
          data = {
            ...next,
            repositories: [...data.repositories, ...next.repositories],
            workspaces: [...data.workspaces, ...next.workspaces],
          };
        }
      else loadedPages++;
      if (c.signal.aborted) return;
      setSnapshot((old) =>
        !cursor &&
        old &&
        old.revision === data.revision &&
        old.state === data.state &&
        old.notice === data.notice &&
        old.repositories.length === data.repositories.length &&
        old.workspaces.length === data.workspaces.length
          ? old
          : cursor && old
            ? {
                ...data,
                repositories: [...old.repositories, ...data.repositories],
                workspaces: [...old.workspaces, ...data.workspaces],
              }
            : data
      );
      setStale("");
    } catch (e) {
      if (!c.signal.aborted) setStale(message(e));
    }
  }
  createEffect(() => {
    const view = section();
    const paired = session();
    controller?.abort();
    setSnapshot(undefined);
    loadedPages = 1;
    setDetail(undefined);
    let stopped = false;
    let scheduled: number | undefined;
    onCleanup(() => {
      stopped = true;
      if (scheduled !== undefined) clearTimeout(scheduled);
      controller?.abort();
    });
    if (!paired || view === "settings") return;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === "visible" && !untrack(dialog)) await load();
      if (!stopped) scheduled = window.setTimeout(tick, 5000);
    };
    void tick();
  });
  const visibility = () => {
    if (document.visibilityState === "hidden") controller?.abort();
    else void load();
  };
  document.addEventListener("visibilitychange", visibility);
  onCleanup(() => {
    controller?.abort();
    if (pollTimer) clearTimeout(pollTimer);
    document.removeEventListener("visibilitychange", visibility);
  });
  const repair = () => {
    const proof = consumeProof();
    if (proof)
      void pair(proof)
        .then(() => setSession(true))
        .catch((e) => setError(message(e)));
  };
  const expired = () => {
    setSession(false);
    setSettings(undefined);
    setError("Session expired. Request a new pairing link in the terminal.");
  };
  window.addEventListener("hashchange", repair);
  window.addEventListener("outpost:session-expired", expired);
  onCleanup(() => {
    window.removeEventListener("hashchange", repair);
    window.removeEventListener("outpost:session-expired", expired);
  });
  repair();
  async function follow(op: Operation) {
    setOperation(op);
    if (
      activeInput?.kind === "inspect-workspace" &&
      activeInput.handle === workspaceHandle() &&
      op.result?.kind === "workspace-readiness"
    ) {
      setReadiness(op.result);
      setReadinessRevision(activeRevision);
    }
    if (["accepted", "running", "draining"].includes(op.state)) {
      pollTimer = window.setTimeout(async () => {
        try {
          await follow(await api.operation(op.id));
        } catch {
          setOperation({
            ...op,
            state: "unknown",
            message: "The outcome is unknown. Do not resubmit automatically.",
          });
          setBusy(false);
        }
      }, 1000);
    } else {
      setBusy(false);
      if (section() === "settings") {
        try {
          const latest = await api.settings();
          setSettings(latest);
          if (op.state === "succeeded") {
            if (activeInput?.kind === "set-future-root") setPath(latest.worktreesRoot);
            if (
              activeInput?.kind === "set-instructions" ||
              activeInput?.kind === "clear-instructions"
            )
              setInstructions(latest.extraInstructions);
          }
        } catch (e) {
          setError(message(e));
        }
      } else void load();
    }
  }
  async function submit(
    input: OperationInput,
    revision = dialogRevision() ?? snapshot()?.revision
  ) {
    if (!revision || busy()) return;
    const submittedDialog = dialog();
    if (input.kind === "register" || input.kind === "import") {
      const control = (value: string) =>
        [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
      const errors: { name?: string; path?: string } = {};
      if (
        input.kind === "register" &&
        (!input.name.trim() ||
          control(input.name) ||
          /[<>:"|?*\\/]/.test(input.name) ||
          /[ .]$/.test(input.name) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(input.name))
      )
        errors.name = "Enter a portable repository name without reserved characters.";
      if (
        !/^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(input.checkoutPath) ||
        control(input.checkoutPath)
      )
        errors.path = "Enter an absolute native checkout path.";
      setFieldErrors(errors);
      if (errors.name || errors.path) {
        queueMicrotask(() => document.getElementById(errors.name ? "name" : "path")?.focus());
        return;
      }
    }
    if (input.kind === "create-workspace") {
      const matches = createRepos().filter(
        (r) =>
          (input.selection.handles.length === 0 || input.selection.handles.includes(r.handle)) &&
          input.selection.tags.every((t) => r.tags.includes(t))
      );
      const borrowed = matches.some((r) => r.kind === "borrowed");
      const managed = matches.some((r) => r.kind === "managed");
      let problem = "";
      if (!input.ticket.trim() || !input.type.trim()) problem = "Enter a ticket and branch type.";
      else if (!input.selection.handles.length && !input.selection.tags.length)
        problem = "Select repositories or enter tags.";
      else if (!matches.length) problem = "No repositories match the selection and tags.";
      else if (input.mode.kind === "reuse" && !input.mode.branch.trim())
        problem = "Enter the existing managed branch.";
      else if (input.mode.kind === "reuse" && borrowed)
        problem = "Registered clones cannot reuse an existing branch.";
      else if (input.mode.kind === "base" && borrowed && (!input.mode.source || !input.mode.ref))
        problem =
          "For registered clones, open base and branch options and choose a source and ref.";
      else if (
        input.mode.kind === "base" &&
        borrowed &&
        input.mode.source === "local" &&
        !/^(?:refs\/(?:heads|tags)\/.+|[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.mode.ref ?? "")
      )
        problem = "For a local clone base, enter a full heads or tags ref, or a commit SHA.";
      else if (
        input.mode.kind === "base" &&
        borrowed &&
        input.mode.source !== "local" &&
        !input.mode.remote
      )
        problem = "Enter a remote name for registered-clone cached or fresh bases.";
      else if (input.mode.kind === "base" && input.mode.source === "local" && input.mode.remote)
        problem = "A local base does not use a remote name.";
      else if (
        input.mode.kind === "base" &&
        input.mode.source === "fresh-remote" &&
        input.mode.remote &&
        borrowed &&
        managed
      )
        problem = "A named fresh base requires registered clones only.";
      if (problem) {
        setDialogError(problem);
        return;
      }
    }
    setDialogError("");
    const requestId = crypto.randomUUID();
    setOperation({
      id: requestId,
      state: "submitting",
      message: "Waiting for the manager to admit this request.",
    });
    setBusy(true);
    activeInput = input;
    activeRevision = revision;
    setError("");
    try {
      const accepted = await api.submit(revision, input, requestId);
      if (accepted.state === "failed") {
        if (operation()?.id === requestId) setOperation(accepted);
        setBusy(false);
        if (dialog() === submittedDialog)
          setDialogError(
            accepted.message ?? "Action refused. Check the entered fields and selected state."
          );
        else setError(accepted.message ?? "Action refused.");
        return;
      }
      if (dialog() === submittedDialog) closeDialog();
      await follow(accepted);
    } catch (e) {
      setBusy(false);
      if (e instanceof ApiError) {
        if (operation()?.id === requestId)
          setOperation({ id: requestId, state: "failed", message: message(e) });
        if (dialog() === submittedDialog) setDialogError(message(e));
        else setError(message(e));
        return;
      }
      if (e instanceof UnknownOperationFailure) {
        setOperation({ id: e.requestId, state: "unknown", message: e.message });
        if (dialog() === submittedDialog) closeDialog();
      }
      setError(
        `Request outcome may be unknown. ${message(e)} Reload before deliberately submitting again.`
      );
    }
  }
  async function openWorkspace(handle: string) {
    setWorkspaceHandle(handle);
    setReadiness(undefined);
    controller?.abort();
    const c = new AbortController();
    controller = c;
    try {
      setDetail(await api.workspace(handle, c.signal));
    } catch (e) {
      if (!c.signal.aborted) setError(message(e));
    }
  }
  async function openCreate() {
    try {
      let page = await api.snapshot("repositories");
      const revision = page.revision;
      const repos = [...page.repositories];
      while (page.nextCursor) {
        page = await api.snapshot("repositories", page.nextCursor);
        if (page.revision !== revision || repos.length + page.repositories.length > 128)
          throw new Error("Repository list changed or exceeds the selection limit. Use the CLI.");
        repos.push(...page.repositories);
      }
      const settings = await api.settings();
      if (settings.revision !== revision || !["ok", "partial"].includes(page.state))
        throw new Error("Recorded state changed. Reload and try again.");
      setCreateRepos(repos.filter((r) => !r.retained));
      setCreateSelected([]);
      setCreateTicket("");
      setCreateType("feat");
      setCreateTags("");
      setCreateMode("base");
      setCreateSource("");
      setCreateBase("");
      setCreateRemote("");
      setCreateBranch("");
      setCreateRoot(settings.worktreesRoot);
      openDialog("create");
      setDialogRevision(revision);
    } catch (e) {
      setError(message(e));
    }
  }
  async function editSettings() {
    try {
      const s = await api.settings();
      setSettings(s);
      setPath(s.worktreesRoot);
      setInstructions(s.extraInstructions);
    } catch (e) {
      setError(message(e));
    }
  }
  let dialogTrigger: HTMLElement | undefined;
  function openDialog(kind: string, handle = "") {
    setDialogRevision(snapshot()?.revision ?? settings()?.revision);
    dialogTrigger =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const mobileTrigger = dialogTrigger
      ?.closest(".repository-actions")
      ?.querySelector<HTMLButtonElement>(".mobile-actions-toggle");
    if (mobileTrigger?.getClientRects().length) dialogTrigger = mobileTrigger;
    setRepoActions("");
    setSelected(handle);
    setDialogError("");
    setFieldErrors({});
    setDialog(kind);
    setError("");
  }
  function closeDialog() {
    queueMicrotask(() => dialogTrigger?.isConnected && dialogTrigger.focus());
    setDialog("");
  }
  createEffect(() => {
    if (dialog())
      queueMicrotask(() => document.querySelector<HTMLDialogElement>("dialog")?.showModal());
  });
  return (
    <>
      <Show
        when={session()}
        fallback={
          <main class="pair">
            <h1>Outpost</h1>
            <h2>Connect to the manager</h2>
            <p>
              Use the pairing link shown in the terminal. Press p in the manager terminal for a new
              link.
            </p>
            <Show when={error()}>
              <p role="alert">{error()}</p>
            </Show>
          </main>
        }
      >
        <div class="shell">
          <aside>
            <strong>Outpost</strong>
            <nav aria-label="Main navigation">
              <For each={["repositories", "workspaces", "settings"] as const}>
                {(item) => (
                  <button
                    type="button"
                    classList={{ active: section() === item }}
                    onClick={() => {
                      setSection(item);
                      setMenu(false);
                      setSettings(undefined);
                    }}
                  >
                    {item[0].toUpperCase() + item.slice(1)}
                  </button>
                )}
              </For>
            </nav>
            <div class="aside-actions">
              <button type="button" onClick={() => openDialog("signout")}>
                Sign out
              </button>
              <button type="button" onClick={() => openDialog("stop")}>
                Stop manager
              </button>
            </div>
          </aside>
          <header class="mobile">
            <strong>Outpost</strong>
            <button type="button" onClick={() => setMenu(!menu())} aria-expanded={menu()}>
              Menu
            </button>
            <Show when={menu()}>
              <nav>
                <For each={["repositories", "workspaces", "settings"] as const}>
                  {(item) => (
                    <button
                      type="button"
                      onClick={() => {
                        setSection(item);
                        setMenu(false);
                        setSettings(undefined);
                      }}
                    >
                      {item[0].toUpperCase() + item.slice(1)}
                    </button>
                  )}
                </For>
                <button type="button" onClick={() => openDialog("signout")}>
                  Sign out
                </button>
                <button type="button" onClick={() => openDialog("stop")}>
                  Stop manager
                </button>
              </nav>
            </Show>
          </header>
          <main>
            <Show when={error()}>
              <div class="notice" role="alert">
                {error()}{" "}
                <button type="button" onClick={() => setError("")}>
                  Dismiss
                </button>
              </div>
            </Show>
            <Show when={operation()}>
              {(op) => (
                <div class="notice" role="status">
                  Operation: {op().state}. {op().message} {(() => {
                    const result = op().result;
                    return result?.kind === "workspace-created"
                      ? ` ${result.ticket}: ${result.memberCount} repositories.`
                      : "";
                  })()}
                  <Show when={op().state === "unknown" && op().id}>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await follow(await api.operation(op().id));
                        } catch (e) {
                          setError(message(e));
                        }
                      }}
                    >
                      Check outcome
                    </button>
                  </Show>
                  <Show when={busy() && op().id && !dialog()}>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await follow(await api.cancel(op().id));
                        } catch (e) {
                          setError(message(e));
                        }
                      }}
                    >
                      Cancel operation
                    </button>
                  </Show>
                </div>
              )}
            </Show>
            <Show when={section() === "repositories"}>
              <div class="title">
                <h1>Repositories</h1>
                <div class="actions">
                  <button
                    type="button"
                    class="primary"
                    disabled={busy() || !["ok", "partial"].includes(snapshot()?.state ?? "")}
                    onClick={() => {
                      setName("");
                      setPath("");
                      openDialog("register");
                    }}
                  >
                    Register repository
                  </button>
                  <button
                    type="button"
                    disabled={busy() || !["ok", "partial"].includes(snapshot()?.state ?? "")}
                    onClick={() => {
                      setPath("");
                      setRemoteName("");
                      openDialog("import");
                    }}
                  >
                    Import repository
                  </button>
                </div>
              </div>
              <p class="muted">Recorded repositories. Verification runs only when requested.</p>
              <div class="tabs">
                <button
                  type="button"
                  classList={{ active: !retained() }}
                  onClick={() => setRetained(false)}
                >
                  Registered
                </button>
                <button
                  type="button"
                  classList={{ active: retained() }}
                  onClick={() => setRetained(true)}
                >
                  Retained
                </button>
              </div>
              <SnapshotNotice snapshot={snapshot()} stale={stale()} />
              <div class="filters">
                <label>
                  Search loaded repositories
                  <input value={search()} onInput={(e) => setSearch(e.currentTarget.value)} />
                </label>
                <label>
                  Filter by tags
                  <input
                    value={tagFilter()}
                    onInput={(e) => setTagFilter(e.currentTarget.value)}
                    placeholder="tag, another tag"
                  />
                </label>
                <button
                  type="button"
                  aria-pressed={groupTags()}
                  onClick={() => setGroupTags(!groupTags())}
                >
                  Group by tag
                </button>
              </div>
              <div class="list">
                <Show when={snapshot()} fallback={<p>Loading recorded repositories...</p>}>
                  <For
                    each={visibleRepositories()}
                    fallback={
                      <p>
                        {search().trim() || tagFilter().trim()
                          ? "No repositories match these filters."
                          : `No ${retained() ? "retained" : "registered"} repositories recorded.`}
                      </p>
                    }
                  >
                    {(entry) => {
                      const r = entry.repo;
                      return (
                        <>
                          <Show when={entry.heading}>
                            <h2 class="group-heading">{entry.heading}</h2>
                          </Show>
                          <div class="row">
                            <div>
                              <button
                                type="button"
                                class="text"
                                aria-expanded={repoDetail() === r.handle}
                                onClick={() =>
                                  setRepoDetail(repoDetail() === r.handle ? "" : r.handle)
                                }
                              >
                                {r.name}
                              </button>
                              <div class="meta">
                                {r.kind === "managed" ? "Managed" : "Registered clone"}
                                {repoDetail() === r.handle && r.path && (
                                  <>
                                    {" "}
                                    · <span class="mono">{r.path}</span>
                                    <button type="button" onClick={() => void copyPath(r.path)}>
                                      Copy path
                                    </button>
                                  </>
                                )}
                              </div>
                              <Show when={r.tags.length > 0}>
                                <div class="meta">Tags: {r.tags.join(", ")}</div>
                              </Show>
                            </div>
                            <fieldset
                              class="repository-actions"
                              aria-label={`Actions for ${r.name}`}
                              onKeyDown={(event) => {
                                if (event.key === "Escape") {
                                  setRepoActions("");
                                  event.currentTarget
                                    .querySelector<HTMLButtonElement>(".mobile-actions-toggle")
                                    ?.focus();
                                }
                              }}
                            >
                              <button
                                type="button"
                                class="mobile-actions-toggle"
                                aria-label={`Actions for ${r.name}`}
                                aria-expanded={repoActions() === r.handle}
                                onClick={() =>
                                  setRepoActions(repoActions() === r.handle ? "" : r.handle)
                                }
                              >
                                Actions
                              </button>
                              <div
                                class="actions"
                                classList={{ "mobile-open": repoActions() === r.handle }}
                              >
                                <Show when={!r.retained}>
                                  <button
                                    type="button"
                                    disabled={busy()}
                                    onClick={() => openDialog("verify", r.handle)}
                                  >
                                    Verify
                                  </button>
                                  <button
                                    type="button"
                                    disabled={busy()}
                                    onClick={() => {
                                      setTags(r.tags.join(", "));
                                      openDialog("tags", r.handle);
                                    }}
                                  >
                                    Edit tags
                                  </button>
                                  <button
                                    type="button"
                                    disabled={busy()}
                                    onClick={() => openDialog("unregister", r.handle)}
                                  >
                                    Unregister
                                  </button>
                                </Show>
                                <Show when={r.retained}>
                                  <button
                                    type="button"
                                    disabled={busy()}
                                    onClick={() => openDialog("restore", r.handle)}
                                  >
                                    Restore
                                  </button>
                                </Show>
                              </div>
                            </fieldset>
                          </div>
                        </>
                      );
                    }}
                  </For>
                </Show>
              </div>
              <Show when={snapshot()?.nextCursor}>
                <p class="muted">Filters apply to loaded repositories.</p>
                <button
                  type="button"
                  onClick={() => void load(snapshot()?.nextCursor || undefined)}
                >
                  Load more
                </button>
              </Show>
            </Show>
            <Show when={section() === "workspaces"}>
              <Show
                when={!detail()}
                fallback={
                  <>
                    <button type="button" onClick={() => setDetail(undefined)}>
                      ← Workspaces
                    </button>
                    <h1>{detail()?.ticket}</h1>
                    <button type="button" onClick={() => void copyPath(detail()?.ticket)}>
                      Copy ticket ID
                    </button>
                    <p class="muted">
                      Recorded metadata. Working state is checked only on request.
                    </p>
                    <p>Checking may run Git and configured tools, which can contact a network.</p>
                    <button
                      type="button"
                      disabled={busy()}
                      onClick={() => {
                        setReadiness(undefined);
                        void submit(
                          { kind: "inspect-workspace", handle: workspaceHandle() },
                          detail()?.revision
                        );
                      }}
                    >
                      Check readiness
                    </button>
                    <Show when={readiness()}>
                      {(r) => (
                        <div class="notice">
                          <p>
                            Readiness: {r().readiness} · Checked {r().checkedAt}
                          </p>
                          <Show when={snapshot()?.revision !== readinessRevision()}>
                            <p>Recorded state changed since this check. Check again.</p>
                          </Show>
                          <Show when={r().reason !== "none"}>
                            <p>
                              Preserve work and inspect with the CLI workspace resume or doctor
                              command.
                            </p>
                          </Show>
                          <For each={r().members}>
                            {(m) => (
                              <p>
                                {m.name}: {m.readiness}, working state {m.workingState}
                                {m.trackedEntries !== undefined
                                  ? ` · ${m.trackedEntries} tracked, ${m.untrackedEntries} untracked, ${m.conflictedEntries} conflicts`
                                  : ""}
                              </p>
                            )}
                          </For>
                          <p>This observation describes the time of the check.</p>
                        </div>
                      )}
                    </Show>
                    <Show when={detail()?.notice}>
                      <div class="notice">{detail()?.notice}</div>
                    </Show>
                    <dl>
                      <dt>Created</dt>
                      <dd>{detail()?.createdAt ?? "Not recorded"}</dd>
                      <dt>Recorded expected branch</dt>
                      <dd class="mono">{detail()?.recordedBranch || "Not recorded"}</dd>
                      <dt>Recorded path</dt>
                      <dd class="mono">
                        {detail()?.path || "Not recorded"}
                        <Show when={detail()?.path}>
                          <button type="button" onClick={() => void copyPath(detail()?.path)}>
                            Copy path
                          </button>
                        </Show>
                      </dd>
                    </dl>
                    <h2>Repositories</h2>
                    <For each={detail()?.members}>
                      {(m) => (
                        <div class="row">
                          <div>
                            <strong>{m.name}</strong>
                            <p class="mono meta">
                              {m.path}
                              <Show when={m.path}>
                                <button type="button" onClick={() => void copyPath(m.path)}>
                                  Copy path
                                </button>
                              </Show>
                            </p>
                            <details>
                              <summary>Original base provenance</summary>
                              <p class="meta">
                                Original base:{" "}
                                {[
                                  m.originalBase?.source,
                                  m.originalBase?.ref,
                                  m.originalBase?.commit,
                                ]
                                  .filter(Boolean)
                                  .join(" · ") || "Not recorded"}
                              </p>
                            </details>
                          </div>
                        </div>
                      )}
                    </For>
                  </>
                }
              >
                <div class="title">
                  <h1>Workspaces</h1>
                  <button
                    type="button"
                    class="primary"
                    disabled={busy()}
                    onClick={() => void openCreate()}
                  >
                    Create workspace
                  </button>
                </div>
                <p class="muted">
                  Recorded workspace metadata. Current working state is not checked.
                </p>
                <SnapshotNotice snapshot={snapshot()} stale={stale()} />
                <div class="list">
                  <Show when={snapshot()} fallback={<p>Loading recorded workspaces...</p>}>
                    <For each={snapshot()?.workspaces} fallback={<p>No workspaces recorded.</p>}>
                      {(w) => (
                        <div class="row">
                          <div>
                            <strong>{w.ticket}</strong>
                            <div class="meta">
                              {w.repositoryCount} repositories · {w.metadataState}
                              <span> · Created {w.createdAt ?? "Not recorded"}</span>
                              {w.diagnostic && ` · ${w.diagnostic}`}
                            </div>
                          </div>
                          <button type="button" onClick={() => void openWorkspace(w.handle)}>
                            Details
                          </button>
                        </div>
                      )}
                    </For>
                  </Show>
                </div>
                <Show when={snapshot()?.nextCursor}>
                  <button
                    type="button"
                    onClick={() => void load(snapshot()?.nextCursor || undefined)}
                  >
                    Load more
                  </button>
                </Show>
              </Show>
            </Show>
            <Show when={section() === "settings"}>
              <h1>Settings</h1>
              <p class="muted">Changes apply to future workspaces.</p>
              <Show
                when={settings()}
                fallback={
                  <button type="button" onClick={() => void editSettings()}>
                    Open settings editor
                  </button>
                }
              >
                {(s) => (
                  <>
                    <section>
                      <h2>Worktree root</h2>
                      <p class="muted">
                        New workspaces only. Existing workspace paths stay unchanged.
                      </p>
                      <label for="worktree-root">Absolute path</label>
                      <input
                        id="worktree-root"
                        value={path()}
                        onInput={(e) => setPath(e.currentTarget.value)}
                      />
                      <button
                        type="button"
                        disabled={busy()}
                        onClick={() =>
                          void submit(
                            { kind: "set-future-root", absolutePath: path() },
                            s().revision
                          )
                        }
                      >
                        Save root
                      </button>
                    </section>
                    <section>
                      <h2>Extra guidance</h2>
                      <label for="instructions">Plaintext guidance</label>
                      <textarea
                        id="instructions"
                        value={instructions()}
                        onInput={(e) => setInstructions(e.currentTarget.value)}
                      />
                      <h3>Pending plaintext</h3>
                      <pre>{instructions()}</pre>
                      <div class="actions">
                        <button
                          type="button"
                          disabled={busy()}
                          onClick={() =>
                            void submit(
                              { kind: "set-instructions", text: instructions() },
                              s().revision
                            )
                          }
                        >
                          Save guidance
                        </button>
                        <button type="button" disabled={busy()} onClick={() => openDialog("clear")}>
                          Clear guidance
                        </button>
                      </div>
                    </section>
                  </>
                )}
              </Show>
            </Show>
          </main>
        </div>
      </Show>
      <Show when={dialog()}>
        <dialog
          aria-labelledby="action-title"
          ref={(element) =>
            queueMicrotask(() => {
              if (element.isConnected) element.showModal();
            })
          }
          onCancel={closeDialog}
          onClose={closeDialog}
        >
          <h2 id="action-title">
            {
              (
                {
                  register: "Register repository",
                  import: "Import repository",
                  create: "Create workspace",
                  verify: "Verify registration",
                  unregister: "Unregister repository",
                  restore: "Restore repository",
                  tags: "Edit tags",
                  clear: "Clear guidance",
                  stop: "Stop manager",
                  signout: "Sign out",
                } as Record<string, string>
              )[dialog()]
            }
          </h2>
          <Show when={selected()}>
            <p>{snapshot()?.repositories.find((repo) => repo.handle === selected())?.name}</p>
          </Show>
          <Show when={dialogError()}>
            <p class="notice" role="alert">
              {dialogError()}
            </p>
          </Show>
          <Show when={dialog() === "register"}>
            <p>
              Uses your existing clone. No files are copied. Submitting checks the entered location;
              a network-share path may contact that share.
            </p>
            <label for="name">Name</label>
            <input
              id="name"
              aria-invalid={!!fieldErrors().name}
              aria-describedby={fieldErrors().name ? "name-error" : undefined}
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
            />
            <Show when={fieldErrors().name}>
              <p id="name-error" role="alert">
                {fieldErrors().name}
              </p>
            </Show>
            <label for="path">Absolute checkout path</label>
            <input
              id="path"
              aria-invalid={!!fieldErrors().path}
              aria-describedby={fieldErrors().path ? "path-error" : undefined}
              value={path()}
              onInput={(e) => setPath(e.currentTarget.value)}
            />
          </Show>
          <Show when={dialog() === "register" && fieldErrors().path}>
            <p id="path-error" role="alert">
              {fieldErrors().path}
            </p>
          </Show>
          <Show when={dialog() === "import"}>
            <p>
              Imports the selected remote into Outpost managed storage. If already imported, updates
              its remote and fetches. Git may run configured tools and contact the remote.
            </p>
            <label for="path">Absolute checkout path</label>
            <input
              id="path"
              value={path()}
              aria-invalid={!!fieldErrors().path}
              aria-describedby={fieldErrors().path ? "path-error" : undefined}
              onInput={(e) => setPath(e.currentTarget.value)}
            />
            <Show when={fieldErrors().path}>
              <p id="path-error" role="alert">
                {fieldErrors().path}
              </p>
            </Show>
            <label for="remote">Remote name (optional)</label>
            <input
              id="remote"
              value={remoteName()}
              onInput={(e) => setRemoteName(e.currentTarget.value)}
            />
            <p>Specify a remote when the checkout has more than one.</p>
          </Show>
          <Show when={dialog() === "create"}>
            <p>
              Worktrees and guidance will be created under {createRoot()}. Git and configured tools
              may run and contact a network.
            </p>
            <label for="create-ticket">Ticket</label>
            <input
              id="create-ticket"
              value={createTicket()}
              onInput={(e) => setCreateTicket(e.currentTarget.value)}
            />
            <label for="create-type">Branch type</label>
            <input
              id="create-type"
              value={createType()}
              onInput={(e) => setCreateType(e.currentTarget.value)}
            />
            <fieldset class="create-repos">
              <legend>Repositories</legend>
              <For each={createRepos()}>
                {(r) => (
                  <label>
                    <input
                      type="checkbox"
                      checked={createSelected().includes(r.handle)}
                      onChange={(e) =>
                        setCreateSelected((old) =>
                          e.currentTarget.checked
                            ? [...old, r.handle]
                            : old.filter((h) => h !== r.handle)
                        )
                      }
                    />{" "}
                    {r.name} ({r.kind === "borrowed" ? "registered clone" : "managed"})
                  </label>
                )}
              </For>
            </fieldset>
            <label for="create-tags">Require tags, separated by commas (optional)</label>
            <input
              id="create-tags"
              value={createTags()}
              onInput={(e) => setCreateTags(e.currentTarget.value)}
            />
            <details>
              <summary>Base and branch options</summary>
              <p>
                Registered clones require an explicit local ref or named cached/fresh base. Reuse
                applies to managed repositories only.
              </p>
              <label for="create-mode">Branch</label>
              <select
                id="create-mode"
                value={createMode()}
                onChange={(e) => setCreateMode(e.currentTarget.value as "base" | "reuse")}
              >
                <option value="base">Create new branch</option>
                <option value="reuse">Reuse managed branch</option>
              </select>
              <Show
                when={createMode() === "base"}
                fallback={
                  <>
                    <label for="create-branch">Existing branch</label>
                    <input
                      id="create-branch"
                      value={createBranch()}
                      onInput={(e) => setCreateBranch(e.currentTarget.value)}
                    />
                  </>
                }
              >
                <label for="create-source">Base source</label>
                <select
                  id="create-source"
                  value={createSource()}
                  onChange={(e) =>
                    setCreateSource(
                      e.currentTarget.value as "" | "local" | "cached-remote" | "fresh-remote"
                    )
                  }
                >
                  <option value="">Default</option>
                  <option value="local">Local</option>
                  <option value="cached-remote">Cached remote</option>
                  <option value="fresh-remote">Fresh remote (fetch)</option>
                </select>
                <label for="create-base">Base ref (optional)</label>
                <input
                  id="create-base"
                  value={createBase()}
                  onInput={(e) => setCreateBase(e.currentTarget.value)}
                />
                <label for="create-remote">Remote name (optional)</label>
                <input
                  id="create-remote"
                  value={createRemote()}
                  onInput={(e) => setCreateRemote(e.currentTarget.value)}
                />
              </Show>
            </details>
          </Show>
          <Show when={dialog() === "verify"}>
            <p>
              Checks the recorded clone location. Network-share paths may contact that share.
              Working content is not checked.
            </p>
          </Show>
          <Show when={dialog() === "tags"}>
            <label for="tags">Tags, separated by commas</label>
            <input id="tags" value={tags()} onInput={(e) => setTags(e.currentTarget.value)} />
          </Show>
          <Show when={dialog() === "unregister"}>
            <p>Unregistering retains repository storage.</p>
          </Show>
          <Show when={dialog() === "restore"}>
            <p>The server will validate the retained repository before restoring it.</p>
          </Show>
          <Show when={dialog() === "stop"}>
            <p>Stop the manager and drain active work?</p>
          </Show>
          <Show when={busy() && operation()?.id && dialog() !== "stop" && dialog() !== "signout"}>
            <div class="actions">
              <button
                type="button"
                onClick={async () => {
                  try {
                    await follow(await api.cancel(operation()!.id));
                  } catch (e) {
                    setDialogError(message(e));
                  }
                }}
              >
                Cancel operation
              </button>
              <button type="button" onClick={() => openDialog("stop")}>
                Stop manager
              </button>
            </div>
          </Show>
          <div class="dialog-actions">
            <button type="button" onClick={closeDialog}>
              {busy() ? "Close dialog" : "Cancel"}
            </button>
            <button
              type="button"
              class="primary"
              disabled={busy() && dialog() !== "stop" && dialog() !== "signout"}
              onClick={async () => {
                const d = dialog();
                if (d === "create")
                  void submit({
                    kind: "create-workspace",
                    ticket: createTicket(),
                    type: createType(),
                    selection: {
                      handles: createSelected(),
                      tags: createTags()
                        .split(",")
                        .map((t) => t.trim())
                        .filter(Boolean),
                    },
                    mode:
                      createMode() === "reuse"
                        ? { kind: "reuse", branch: createBranch() }
                        : {
                            kind: "base",
                            ...(createSource()
                              ? {
                                  source: createSource() as
                                    | "local"
                                    | "cached-remote"
                                    | "fresh-remote",
                                }
                              : {}),
                            ...(createBase() ? { ref: createBase() } : {}),
                            ...(createRemote() ? { remote: createRemote() } : {}),
                          },
                  });
                else if (d === "import")
                  void submit({
                    kind: "import",
                    checkoutPath: path(),
                    remoteName: remoteName() || undefined,
                  });
                else if (d === "register")
                  void submit({ kind: "register", name: name(), checkoutPath: path() });
                else if (d === "tags") {
                  const old =
                    snapshot()?.repositories.find((r) => r.handle === selected())?.tags || [];
                  const next = tags()
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean);
                  void submit({
                    kind: "tags",
                    handle: selected(),
                    add: next.filter((t) => !old.includes(t)),
                    remove: old.filter((t) => !next.includes(t)),
                  });
                } else if (d === "clear")
                  void submit({ kind: "clear-instructions" }, settings()?.revision);
                else if (d === "verify" || d === "unregister" || d === "restore")
                  void submit({
                    kind: d === "verify" ? "verify-registration" : d,
                    handle: selected(),
                  });
                else if (d === "signout") {
                  try {
                    await api.signOut();
                  } catch {}
                  forgetSession();
                  setSession(false);
                  closeDialog();
                } else if (d === "stop") {
                  closeDialog();
                  setBusy(true);
                  setOperation({ id: "", state: "draining", message: "Stopping manager..." });
                  try {
                    await api.stop();
                  } catch {
                    setError("Manager stop was requested. The response was lost.");
                  }
                }
              }}
            >
              Confirm
            </button>
          </div>
        </dialog>
      </Show>
    </>
  );
}
function SnapshotNotice(props: { snapshot: Snapshot | undefined; stale: string }) {
  return (
    <>
      <Show when={props.stale}>
        <div class="notice" role="alert">
          Could not update recorded metadata.{" "}
          {props.snapshot && `Last observed ${props.snapshot.observedAt}.`} {props.stale}
        </div>
      </Show>
      <Show when={props.snapshot && props.snapshot.state !== "ok"}>
        <div class="notice">
          {props.snapshot?.state === "uninitialized"
            ? "Stop this manager, run outpost init in the terminal, then restart outpost manage. Opening the manager does not initialize or repair state."
            : props.snapshot?.notice || `Metadata state: ${props.snapshot?.state}`}
        </div>
      </Show>
    </>
  );
}
render(() => <App />, document.getElementById("root")!);
