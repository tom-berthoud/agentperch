// Lancer avec : gjs -m tests/model.test.js
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
        print(`FAIL  ${name}: obtenu ${a}, attendu ${e}`);
    }
}

const base = {pid: 42, sessionId: 'abc', procStart: '100', status: 'busy', cwd: '/home/u/projet'};

// Normalisation
check('busy -> working', normalizeClaudeSession(base).state, State.WORKING);
check('idle -> idle', normalizeClaudeSession({...base, status: 'idle'}).state, State.IDLE);
check('waiting -> waiting', normalizeClaudeSession({...base, status: 'waiting'}).state, State.WAITING);
check('shell -> background', normalizeClaudeSession({...base, status: 'shell'}).state, State.BACKGROUND);
check('statut inconnu conservé',
    [normalizeClaudeSession({...base, status: 'nouveau'}).state,
        normalizeClaudeSession({...base, status: 'nouveau'}).rawStatus],
    [State.UNKNOWN, 'nouveau']);
check('pid invalide rejeté', normalizeClaudeSession({...base, pid: '42'}), null);
check('pid négatif rejeté', normalizeClaudeSession({...base, pid: -1}), null);
check('null rejeté', normalizeClaudeSession(null), null);
check('champ non retenu', 'messagingSocketPath' in normalizeClaudeSession({...base, messagingSocketPath: '/x'}), false);

// Texte de l'état
const waiting = waitingFor => normalizeClaudeSession({...base, status: 'waiting', waitingFor});
check('permission', stateText(waiting('permission prompt')), 'Demande une permission');
check('question', stateText(waiting('input needed')), 'Pose une question');
check('raison inconnue conservée', stateText(waiting('autre')), 'Attend une réponse (autre)');
check('sans raison', stateText(waiting(undefined)), 'Attend une réponse');
check('statut brut affiché', stateText(normalizeClaudeSession({...base, status: 'x'})), 'État inconnu (x)');
check('statut absent', stateText(normalizeClaudeSession({...base, status: undefined})), 'État inconnu (absent)');

// Icône unique
const withState = (...states) => states.map(state => ({state}));
check('waiting prioritaire', aggregateState(withState(State.IDLE, State.WORKING, State.WAITING)), State.WAITING);
check('working avant background', aggregateState(withState(State.BACKGROUND, State.WORKING)), State.WORKING);
check('inconnu avant idle', aggregateState(withState(State.IDLE, State.UNKNOWN)), State.UNKNOWN);
check('aucune session', aggregateState([]), State.IDLE);

// Sous-agents
check('dossier projet', projectDirName('/tmp/a_b.c/-d'), '-tmp-a-b-c--d');
check('agent actif', isSubagentRunning({}, 2000, 1000), true);
check('agent terminé', isSubagentRunning({finished: true}, 2000, 1000), false);
check('ancien fichier sans finished', isSubagentRunning({finished: null}, 500, 1000), false);
check('agent arrêté par l\'utilisateur', isSubagentRunning({stoppedByUser: true}, 2000, 1000), false);
check('sans transcript', isSubagentRunning({}, 0, 0), false);
check('début de session inconnu', isSubagentRunning({}, 2000, 0), false);

// Tokens
const enc = new TextEncoder();
const assistant = (id, usage, extra = {}) => JSON.stringify({
    type: 'assistant', message: {id, model: 'm1', usage, content: [{text: 'secret'}]}, ...extra,
});
const u1 = {input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 7};
const u2 = {input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 200, output_tokens: 3};
const jsonl = [
    assistant('a', u1),
    assistant('a', u1), // doublon du même message
    JSON.stringify({type: 'user', message: {content: 'mot "usage" dans le texte é'}}),
    '{json cassé "usage"',
    assistant('side', u1, {isSidechain: true}),
    JSON.stringify({type: 'assistant', message: {id: 's', model: '<synthetic>', usage: u1}}),
    assistant('b', u2),
].join('\n') + '\n';
const expected = {input: 18, cacheRead: 300, output: 10, model: 'm1', context: 203};

const whole = new UsageAccumulator();
whole.feed(enc.encode(jsonl));
check('usage: dédoublonné, sans sidechain ni synthétique', whole.totals(), expected);

// Découpe octet par octet : couvre les lignes et les caractères UTF-8 coupés.
const split = new UsageAccumulator();
for (const byte of enc.encode(jsonl))
    split.feed(Uint8Array.of(byte));
check('usage: lecture par morceaux', split.totals(), expected);

const partial = new UsageAccumulator();
partial.feed(enc.encode(assistant('a', u1).slice(0, 20)));
check('usage: ligne incomplète ignorée', partial.totals().model, null);

const sidechain = new UsageAccumulator({includeSidechain: true});
sidechain.feed(enc.encode(`${assistant('side', u1, {isSidechain: true})}\n`));
check('usage: sous-agent compté', sidechain.totals().output, 7);

check('tokens', [formatTokens(950), formatTokens(78_400), formatTokens(2_140_000)], ['950', '78 k', '2,1 M']);

// Lignes du menu
check('détails vides', detailLines({usage: null, agents: null}), []);
check('transcript sans message', detailLines({usage: {model: null}, agents: []}), []);
check('détails usage', detailLines({usage: {...expected}, agents: null}), [
    'Modèle : m1', 'Contexte actuel : 203 tokens', 'Cumul : 18 en entrée · 10 en sortie · 300 lus en cache',
]);
const agent = (running, finished, description = 'd') => ({
    type: 't', description, running, finished, usage: {input: 1000, output: 1000},
});
check('détails agents', detailLines({usage: null, agents: [agent(true, false), agent(false, true), agent(false, false)]}), [
    'Sous-agents : 1 actif(s) sur 3', '▶ t — d · 2 k', '✓ t — d · 2 k', '– t — d · 2 k',
]);
check('agents inactifs limités',
    detailLines({usage: null, agents: Array.from({length: 7}, () => agent(false, true))}).at(-1),
    '+ 2 autre(s)');

// /proc/<pid>/stat
const tail = 'S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 777 19';
check('comm avec espaces et parenthèses',
    parseProcStat(`123 (a b) (c)) ${tail}`), {state: 'S', startTime: '777'});
check('stat tronqué', parseProcStat('123 (a) S 1'), null);
check('stat illisible', parseProcStat('n importe quoi'), null);
check('même processus', isSameLiveProcess({state: 'S', startTime: '777'}, '777'), true);
check('PID réutilisé', isSameLiveProcess({state: 'S', startTime: '778'}, '777'), false);
check('zombie', isSameLiveProcess({state: 'Z', startTime: '777'}, '777'), false);
check('procStart absent', isSameLiveProcess({state: 'R', startTime: '1'}, null), true);

// Affichage
check('secondes', formatDuration(59_000), '59 s');
check('minutes', formatDuration(60_000), '1 min');
check('heures', formatDuration(3_725_000), '1 h 02');
check('durée négative', formatDuration(-5), '0 s');
check('nom prioritaire', displayName({name: 'n', cwd: '/a/b', pid: 1}), 'n');
check('nom depuis cwd', displayName({name: null, cwd: '/a/b/', pid: 1}), 'b');
check('nom depuis pid', displayName({name: null, cwd: null, pid: 1}), 'pid 1');
check('label tronqué', shortLabel({name: 'abcdefghij', pid: 1}, 5), 'abcd…');
check('label unicode', shortLabel({name: 'éééééé', pid: 1}, 3), 'éé…');
check('chemin home', prettyPath('/home/u/x', '/home/u'), '~/x');
check('préfixe similaire', prettyPath('/home/ux/x', '/home/u'), '/home/ux/x');

// Scan réel sur un dossier temporaire, avec le processus de test comme session vivante.
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
    write('broken.json', '{pas du json');
    write('secret.key', 'ne doit jamais être lu');

    const first = await scanSessions(dir, new Map());
    check('scan: seule la session vivante reste', first.sessions.map(s => s.sessionId), ['s']);

    // Écriture partielle : la dernière valeur connue est conservée.
    write('live.json', '{"pid":');
    const second = await scanSessions(dir, first.cache);
    check('scan: écriture partielle tolérée', second.sessions.map(s => s.sessionId), ['s']);

    const none = await scanSessions(`${dir}/absent`, new Map());
    check('scan: dossier absent', none.sessions, []);

    for (const name of ['live.json', 'reused.json', 'dead.json', 'broken.json', 'secret.key'])
        GLib.unlink(`${dir}/${name}`);
    GLib.rmdir(dir);
}

// Lecture réelle : le transcript grandit entre deux lectures, sur un dossier temporaire.
async function testTranscripts() {
    const root = GLib.dir_make_tmp('agentperch-XXXXXX');
    const cwd = '/x/mon_projet';
    const dir = `${root}/-x-mon-projet`;
    const agents = `${dir}/s1/subagents`;
    GLib.mkdir_with_parents(agents, 0o700);
    const line = (id, usage) => `${assistant(id, usage)}\n`;
    GLib.file_set_contents(`${dir}/s1.jsonl`, line('a', u1));
    const session = {sessionId: 's1', cwd, startedAt: 1000};
    const files = new SessionFiles(root, null);

    const first = await files.details(session, {usage: true, subagents: true});
    check('fichiers: tokens lus', first.usage.output, 7);
    check('fichiers: aucun sous-agent', first.agents, []);

    GLib.file_set_contents(`${dir}/s1.jsonl`, line('a', u1) + line('b', u2));
    GLib.file_set_contents(`${agents}/agent-1.meta.json`, JSON.stringify({agentType: 'gp', description: 'desc'}));
    GLib.file_set_contents(`${agents}/agent-1.jsonl`, `${assistant('c', u1, {isSidechain: true})}\n`);
    const usage = await files.details(session, {usage: true, subagents: false});
    check('fichiers: lecture incrémentale', [usage.usage.output, usage.agents], [10, null]);

    // Le passage suivant est limité à un toutes les 2 s : nouvelle instance.
    const fresh = new SessionFiles(root, null);
    check('fichiers: sous-agent actif', await fresh.runningAgentCount(session), 1);
    const stale = new SessionFiles(root, null);
    check('fichiers: sous-agent antérieur à la session',
        await stale.runningAgentCount({...session, startedAt: Date.now() + 60_000}), 0);

    GLib.file_set_contents(`${agents}/agent-1.meta.json`, JSON.stringify({agentType: 'gp', finished: true}));
    const done = new SessionFiles(root, null);
    const details = await done.details(session, {usage: true, subagents: true});
    check('fichiers: sous-agent terminé',
        [details.agents[0].running, details.agents[0].finished, details.agents[0].usage.output], [false, true, 7]);

    const noUsage = new SessionFiles(root, null);
    const hidden = await noUsage.details(session, {usage: false, subagents: true});
    check('fichiers: option tokens coupée, transcript de sous-agent non lu',
        [hidden.usage, hidden.agents[0].usage], [null, null]);
    check('détails: sous-agent sans tokens', detailLines(hidden).at(-1), '✓ gp');

    // Le cwd courant n'est plus celui du lancement : repli sur une recherche.
    const moved = new SessionFiles(root, null);
    const found = await moved.details({...session, cwd: '/ailleurs'}, {usage: true, subagents: false});
    check('fichiers: dossier retrouvé par sessionId', found.usage?.output, 10);

    // Le transcript n'existe qu'après le premier message : pas d'attente de 30 s.
    const late = new SessionFiles(root, null);
    const lateSession = {sessionId: 'tard', cwd, startedAt: 1000};
    const before = await late.details(lateSession, {usage: true, subagents: false});
    GLib.file_set_contents(`${dir}/tard.jsonl`, line('t', u1));
    const after = await late.details(lateSession, {usage: true, subagents: false});
    check('fichiers: transcript apparu après le premier passage', [before.usage, after.usage?.output], [null, 7]);
    GLib.unlink(`${dir}/tard.jsonl`);

    // Appels simultanés : le second ne doit pas recevoir un vide.
    const both = new SessionFiles(root, null);
    const [one, two] = await Promise.all([
        both.details(session, {usage: true, subagents: false}),
        both.details(session, {usage: true, subagents: false}),
    ]);
    check('fichiers: appels simultanés', [one.usage?.output, two.usage?.output], [10, 10]);

    // Lignes écrites juste après `finished` : elles comptent encore.
    const settling = new SessionFiles(root, null);
    await settling.details(session, {usage: true, subagents: true});
    GLib.file_set_contents(`${agents}/agent-1.jsonl`,
        `${assistant('c', u1, {isSidechain: true})}\n${assistant('d', u2, {isSidechain: true})}\n`);
    const settled = await settling.details(session, {usage: true, subagents: true});
    check('fichiers: tokens tardifs d\'un sous-agent terminé', settled.agents[0].usage.output, 10);

    const absent = new SessionFiles(root, null);
    check('fichiers: session sans transcript',
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

print(failures ? `\n${failures} échec(s)` : '\nTous les tests passent');
System.exit(failures ? 1 : 0);
