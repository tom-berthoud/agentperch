// Run with: gjs -m tests/model.test.js
import GLib from 'gi://GLib';
import System from 'system';

import {scanSessions} from '../extension/lib/claudeCode.js';
import {SessionFiles} from '../extension/lib/transcripts.js';
import {
    State,
    UsageAccumulator,
    aggregateState,
    detailLines,
    displayName,
    formatDuration,
    formatTokens,
    isSameLiveProcess,
    isSubagentRunning,
    normalizeClaudeSession,
    parseProcStat,
    prettyPath,
    projectDirName,
    shortLabel,
    stateText,
} from '../extension/lib/model.js';

let failures = 0;
function check(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        print(`ok    ${name}`);
    } else {
        failures++;
        print(`FAIL  ${name}: got ${a}, expected ${e}`);
    }
}

const base = {pid: 42, sessionId: 'abc', procStart: '100', status: 'busy', cwd: '/home/u/project'};

// Normalization
check('busy -> working', normalizeClaudeSession(base).state, State.WORKING);
check('idle -> idle', normalizeClaudeSession({...base, status: 'idle'}).state, State.IDLE);
check('waiting -> waiting', normalizeClaudeSession({...base, status: 'waiting'}).state, State.WAITING);
check('shell -> background', normalizeClaudeSession({...base, status: 'shell'}).state, State.BACKGROUND);
check('unknown status kept',
    [normalizeClaudeSession({...base, status: 'brand-new'}).state,
        normalizeClaudeSession({...base, status: 'brand-new'}).rawStatus],
    [State.UNKNOWN, 'brand-new']);
check('invalid pid rejected', normalizeClaudeSession({...base, pid: '42'}), null);
check('negative pid rejected', normalizeClaudeSession({...base, pid: -1}), null);
check('null rejected', normalizeClaudeSession(null), null);
check('field not kept', 'messagingSocketPath' in normalizeClaudeSession({...base, messagingSocketPath: '/x'}), false);

// State text
const waiting = waitingFor => normalizeClaudeSession({...base, status: 'waiting', waitingFor});
check('permission', stateText(waiting('permission prompt')), 'Asking for permission');
check('question', stateText(waiting('input needed')), 'Asking a question');
check('unknown reason kept', stateText(waiting('other')), 'Waiting for you (other)');
check('no reason', stateText(waiting(undefined)), 'Waiting for you');
check('raw status shown', stateText(normalizeClaudeSession({...base, status: 'x'})), 'Unknown state (x)');
check('status missing', stateText(normalizeClaudeSession({...base, status: undefined})), 'Unknown state (missing)');

// Single icon
const withState = (...states) => states.map(state => ({state}));
check('waiting comes first', aggregateState(withState(State.IDLE, State.WORKING, State.WAITING)), State.WAITING);
check('working before background', aggregateState(withState(State.BACKGROUND, State.WORKING)), State.WORKING);
check('unknown before idle', aggregateState(withState(State.IDLE, State.UNKNOWN)), State.UNKNOWN);
check('no session', aggregateState([]), State.IDLE);

// Subagents
check('project directory', projectDirName('/tmp/a_b.c/-d'), '-tmp-a-b-c--d');
check('running agent', isSubagentRunning({}, 2000, 1000), true);
check('finished agent', isSubagentRunning({finished: true}, 2000, 1000), false);
check('old file without finished', isSubagentRunning({finished: null}, 500, 1000), false);
check('agent stopped by user', isSubagentRunning({stoppedByUser: true}, 2000, 1000), false);
check('no transcript', isSubagentRunning({}, 0, 0), false);
check('session start unknown', isSubagentRunning({}, 2000, 0), false);

// Tokens
const enc = new TextEncoder();
const assistant = (id, usage, extra = {}) => JSON.stringify({
    type: 'assistant', message: {id, model: 'm1', usage, content: [{text: 'secret'}]}, ...extra,
});
const u1 = {input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 7};
const u2 = {input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 200, output_tokens: 3};
const jsonl = [
    assistant('a', u1),
    assistant('a', u1), // duplicate of the same message
    JSON.stringify({type: 'user', message: {content: 'the word "usage" in text é'}}),
    '{broken json "usage"',
    assistant('side', u1, {isSidechain: true}),
    JSON.stringify({type: 'assistant', message: {id: 's', model: '<synthetic>', usage: u1}}),
    assistant('b', u2),
].join('\n') + '\n';
const expected = {input: 18, cacheRead: 300, output: 10, model: 'm1', context: 203};

const whole = new UsageAccumulator();
whole.feed(enc.encode(jsonl));
check('usage: deduplicated, no sidechain or synthetic', whole.totals(), expected);

// Byte by byte: covers cut lines and cut UTF-8 characters.
const split = new UsageAccumulator();
for (const byte of enc.encode(jsonl))
    split.feed(Uint8Array.of(byte));
check('usage: chunked read', split.totals(), expected);

const partial = new UsageAccumulator();
partial.feed(enc.encode(assistant('a', u1).slice(0, 20)));
check('usage: incomplete line ignored', partial.totals().model, null);

const sidechain = new UsageAccumulator({includeSidechain: true});
sidechain.feed(enc.encode(`${assistant('side', u1, {isSidechain: true})}\n`));
check('usage: subagent counted', sidechain.totals().output, 7);

check('tokens', [formatTokens(950), formatTokens(78_400), formatTokens(2_140_000)], ['950', '78k', '2.1M']);

// Menu lines
check('empty details', detailLines({usage: null, agents: null}), []);
check('transcript with no message', detailLines({usage: {model: null}, agents: []}), []);
check('usage details', detailLines({usage: {...expected}, agents: null}), [
    'Model: m1', 'Current context: 203 tokens', 'Total: 18 in · 10 out · 300 cache read',
]);
const agent = (running, finished, description = 'd') => ({
    type: 't', description, running, finished, usage: {input: 1000, output: 1000},
});
check('agent details', detailLines({usage: null, agents: [agent(true, false), agent(false, true), agent(false, false)]}), [
    'Subagents: 1 running of 3', '▶ t — d · 2k', '✓ t — d · 2k', '– t — d · 2k',
]);
check('inactive agents capped',
    detailLines({usage: null, agents: Array.from({length: 7}, () => agent(false, true))}).at(-1),
    '+ 2 more');

// /proc/<pid>/stat
const tail = 'S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 777 19';
check('comm with spaces and parentheses',
    parseProcStat(`123 (a b) (c)) ${tail}`), {state: 'S', startTime: '777'});
check('truncated stat', parseProcStat('123 (a) S 1'), null);
check('unreadable stat', parseProcStat('garbage'), null);
check('same process', isSameLiveProcess({state: 'S', startTime: '777'}, '777'), true);
check('reused PID', isSameLiveProcess({state: 'S', startTime: '778'}, '777'), false);
check('zombie', isSameLiveProcess({state: 'Z', startTime: '777'}, '777'), false);
check('procStart missing', isSameLiveProcess({state: 'R', startTime: '1'}, null), true);

// Display
check('seconds', formatDuration(59_000), '59 s');
check('minutes', formatDuration(60_000), '1 min');
check('hours', formatDuration(3_725_000), '1 h 02');
check('negative duration', formatDuration(-5), '0 s');
check('name comes first', displayName({name: 'n', cwd: '/a/b', pid: 1}), 'n');
check('name from cwd', displayName({name: null, cwd: '/a/b/', pid: 1}), 'b');
check('name from pid', displayName({name: null, cwd: null, pid: 1}), 'pid 1');
check('truncated label', shortLabel({name: 'abcdefghij', pid: 1}, 5), 'abcd…');
check('label unicode', shortLabel({name: 'éééééé', pid: 1}, 3), 'éé…');
check('home path', prettyPath('/home/u/x', '/home/u'), '~/x');
check('similar prefix', prettyPath('/home/ux/x', '/home/u'), '/home/ux/x');

// Real scan on a temp directory, with the test process as the live session.
async function testScan() {
    const dir = GLib.dir_make_tmp('agentperch-XXXXXX');
    const write = (name, content) => GLib.file_set_contents(`${dir}/${name}`, content);
    const [, statBytes] = GLib.file_get_contents('/proc/self/stat');
    const statText = new TextDecoder().decode(statBytes);
    const pid = parseInt(statText, 10);
    const start = parseProcStat(statText).startTime;
    const live = {pid, sessionId: 's', procStart: start, status: 'busy', startedAt: 2};

    write('live.json', JSON.stringify(live));
    write('reused.json', JSON.stringify({...live, sessionId: 'r', procStart: '1'}));
    write('dead.json', JSON.stringify({...live, pid: 2147483646, sessionId: 'd'}));
    write('broken.json', '{not json');
    write('secret.key', 'must never be read');

    const first = await scanSessions(dir, new Map());
    check('scan: only the live session remains', first.sessions.map(s => s.sessionId), ['s']);

    // Partial write: the last known value is kept.
    write('live.json', '{"pid":');
    const second = await scanSessions(dir, first.cache);
    check('scan: partial write tolerated', second.sessions.map(s => s.sessionId), ['s']);

    const none = await scanSessions(`${dir}/absent`, new Map());
    check('scan: missing directory', none.sessions, []);

    for (const name of ['live.json', 'reused.json', 'dead.json', 'broken.json', 'secret.key'])
        GLib.unlink(`${dir}/${name}`);
    GLib.rmdir(dir);
}

// Real read on a temp directory: the transcript grows between reads.
async function testTranscripts() {
    const root = GLib.dir_make_tmp('agentperch-XXXXXX');
    const cwd = '/x/my_project';
    const dir = `${root}/-x-my-project`;
    const agents = `${dir}/s1/subagents`;
    GLib.mkdir_with_parents(agents, 0o700);
    const line = (id, usage) => `${assistant(id, usage)}\n`;
    GLib.file_set_contents(`${dir}/s1.jsonl`, line('a', u1));
    const session = {sessionId: 's1', cwd, startedAt: 1000};
    const files = new SessionFiles(root, null);

    const first = await files.details(session, {usage: true, subagents: true});
    check('files: tokens read', first.usage.output, 7);
    check('files: no subagent', first.agents, []);

    GLib.file_set_contents(`${dir}/s1.jsonl`, line('a', u1) + line('b', u2));
    GLib.file_set_contents(`${agents}/agent-1.meta.json`, JSON.stringify({agentType: 'gp', description: 'desc'}));
    GLib.file_set_contents(`${agents}/agent-1.jsonl`, `${assistant('c', u1, {isSidechain: true})}\n`);
    const usage = await files.details(session, {usage: true, subagents: false});
    check('files: incremental read', [usage.usage.output, usage.agents], [10, null]);

    // Passes are limited to one every 2 s: new instance.
    const fresh = new SessionFiles(root, null);
    check('files: running subagent', await fresh.runningAgentCount(session), 1);
    const stale = new SessionFiles(root, null);
    check('files: subagent older than the session',
        await stale.runningAgentCount({...session, startedAt: Date.now() + 60_000}), 0);

    GLib.file_set_contents(`${agents}/agent-1.meta.json`, JSON.stringify({agentType: 'gp', finished: true}));
    const done = new SessionFiles(root, null);
    const details = await done.details(session, {usage: true, subagents: true});
    check('files: finished subagent',
        [details.agents[0].running, details.agents[0].finished, details.agents[0].usage.output], [false, true, 7]);

    const noUsage = new SessionFiles(root, null);
    const hidden = await noUsage.details(session, {usage: false, subagents: true});
    check('files: token option off, subagent transcript not read',
        [hidden.usage, hidden.agents[0].usage], [null, null]);
    check('details: subagent without tokens', detailLines(hidden).at(-1), '✓ gp');

    // The current cwd is no longer the launch one: fall back to a search.
    const moved = new SessionFiles(root, null);
    const found = await moved.details({...session, cwd: '/elsewhere'}, {usage: true, subagents: false});
    check('files: directory found by sessionId', found.usage?.output, 10);

    // The transcript exists only after the first message: no 30 s wait.
    const late = new SessionFiles(root, null);
    const lateSession = {sessionId: 'late', cwd, startedAt: 1000};
    const before = await late.details(lateSession, {usage: true, subagents: false});
    GLib.file_set_contents(`${dir}/late.jsonl`, line('t', u1));
    const after = await late.details(lateSession, {usage: true, subagents: false});
    check('files: transcript appeared after the first pass', [before.usage, after.usage?.output], [null, 7]);
    GLib.unlink(`${dir}/late.jsonl`);

    // Concurrent calls: the second must not get an empty result.
    const both = new SessionFiles(root, null);
    const [one, two] = await Promise.all([
        both.details(session, {usage: true, subagents: false}),
        both.details(session, {usage: true, subagents: false}),
    ]);
    check('files: concurrent calls', [one.usage?.output, two.usage?.output], [10, 10]);

    // Lines written right after `finished` still count.
    const settling = new SessionFiles(root, null);
    await settling.details(session, {usage: true, subagents: true});
    GLib.file_set_contents(`${agents}/agent-1.jsonl`,
        `${assistant('c', u1, {isSidechain: true})}\n${assistant('d', u2, {isSidechain: true})}\n`);
    const settled = await settling.details(session, {usage: true, subagents: true});
    check('files: late tokens of a finished subagent', settled.agents[0].usage.output, 10);

    const absent = new SessionFiles(root, null);
    check('files: session without transcript',
        await absent.details({sessionId: 'x', cwd: '/y', startedAt: 0}, {usage: true, subagents: true}),
        {usage: null, agents: []});

    for (const path of [`${agents}/agent-1.meta.json`, `${agents}/agent-1.jsonl`, `${dir}/s1.jsonl`])
        GLib.unlink(path);
    for (const path of [agents, `${dir}/s1`, dir, root])
        GLib.rmdir(path);
}

const loop = new GLib.MainLoop(null, false);
testScan()
    .then(testTranscripts)
    .catch(e => {
        failures++;
        print(`FAIL  scan: ${e}\n${e.stack}`);
    })
    .finally(() => loop.quit());
loop.run();

print(failures ? `\n${failures} failure(s)` : '\nAll tests pass');
System.exit(failures ? 1 : 0);
