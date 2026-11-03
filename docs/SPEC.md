# AgentPerch : spécification v1

## Objectif

Savoir d'un coup d'œil, depuis la barre GNOME, quelle session d'agent travaille,
a terminé ou attend une réponse, sans revenir dans le terminal.

## Hors périmètre de la v1

- Quotas d'abonnement et coût en argent
- Retour au terminal, reprise d'une session
- Réponse aux demandes de permission depuis le panneau
- Autres outils que Claude Code
- Publication sur extensions.gnome.org
- Logo, notifications

## Modèle de données

Chaque adaptateur produit des sessions dans un format commun :

```text
session
├── source        "claude-code"
├── key           identifiant stable d'un processus (pid + starttime)
├── sessionId, pid, procStart, kind, cwd, name
├── state         working | waiting | background | idle | unknown
├── rawStatus     valeur source, conservée pour le diagnostic
├── waitingFor    raison de l'attente, si elle est connue
└── startedAt, statusSince
```

## Sources d'état

`~/.claude/sessions/<pid>.json` : format non documenté, observé sur Claude Code
2.1.317 en pilotant une session réelle.

| `status` | `waitingFor` | Situation observée | État |
|---|---|---|---|
| `busy` | | Le modèle travaille, commande au premier plan incluse | `working` |
| `waiting` | `permission prompt` | Demande de permission (Bash, Write) | `waiting` |
| `waiting` | `input needed` | Question (`AskUserQuestion`) | `waiting` |
| `shell` | | Tour terminé, commande encore en arrière-plan | `background` |
| `idle` | | Plus rien en cours | `idle` |
| autre | | Non observé | `unknown`, valeur brute affichée |

Les hooks Claude Code restent une option si le format change, ou s'il faut
distinguer « a terminé » de « n'a encore rien fait ». Ils ne sont plus nécessaires
pour détecter une demande de permission.

## Sous-agents et tokens

`~/.claude/projects/<cwd transformé>/` :

- `<sessionId>.jsonl` : `message.usage` et `message.model` sur les lignes
  `assistant`. Un même `message.id` se répète sur plusieurs lignes : il ne compte
  qu'une fois.
- `<sessionId>/subagents/agent-*.meta.json` : `agentType`, `description`,
  `finished`. `finished` est absent pendant l'exécution, puis vaut `true`.
- `<sessionId>/subagents/agent-*.jsonl` : même format d'usage.

Un sous-agent est actif si `finished` n'est pas `true` et si son transcript a été
modifié depuis le lancement du processus : les anciens fichiers n'ont jamais
`finished`.

Le « contexte actuel » additionne les tokens d'entrée du dernier message. Il n'y a
pas de pourcentage : la taille de la fenêtre de contexte n'apparaît pas dans ces
fichiers.

## Règles de conception

- Aucune I/O bloquante : le code tourne dans le processus de GNOME Shell.
- Une session morte se détecte par son PID et son `starttime`, jamais par la
  seule présence d'un fichier.
- `disable()` retire toutes les icônes, sources GLib et moniteurs.
- L'extension n'ouvre jamais les fichiers `.key` de `~/.claude/sessions/`, ni
  les identifiants de Claude Code.
- Les transcripts contiennent les conversations : ils ne sont lus que menu ouvert
  et option tokens active, de façon incrémentale, et seuls les nombres et le modèle
  sont conservés.
- Les `.meta.json` des sous-agents sont lus en continu si l'option sous-agents est
  active. Leur `description` est du texte de tâche, conservé en mémoire et affiché.
- Une icône par session ou une seule icône, au choix. Les sous-agents sont un
  badge, pas des icônes.

## Questions ouvertes

1. Comment distinguer « a terminé » de « n'a encore rien fait » ? `idle` couvre
   les deux.
2. Les sessions d'un autre `kind` qu'`interactive` doivent-elles apparaître ?
3. `pidDomain` a-t-il un rôle à jouer pour les sessions lancées en conteneur ?
4. Le délai d'affichage et l'encombrement de la barre conviennent-ils à l'usage ?
