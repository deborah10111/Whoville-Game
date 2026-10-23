# Whoville-Game

# Welcome to Whoville — multiplayer prototype

A React/Vite multiplayer prototype using Supabase anonymous guest sessions and Row Level Security for player-specific views.

## Run

1. Install Node.js (version 20 or later).
2. Open this folder in VS Code.
3. Run `npm install`.
4. Run `npm run dev`.
5. Open the localhost URL printed by Vite.

## Supabase setup

1. Create a Supabase project on the Free plan and enable Anonymous Sign-Ins in Authentication > Providers.
2. In the Supabase SQL Editor, run the complete contents of `supabase/schema.sql`.
3. Copy `.env.example` to `.env.local` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from the project's API settings.
4. Run `npm run dev`. A host creates a game and shares its room code; each friend chooses a display name and joins from their own device/browser using that code.

Do not put a Supabase service-role key in `.env.local` or any `VITE_` variable. The frontend only uses the public anon/publishable key; PostgreSQL functions perform privileged operations with authenticated-user checks.

The project URL and public anon/publishable key are issued with the project and do not require a paid plan. Supabase Free currently includes two active projects and 500 MB of database storage; free projects may pause after one week of inactivity. Check the official [pricing page](https://supabase.com/pricing) for current limits.

## Player access and privacy

- Each player gets a Supabase anonymous guest account on their own device/browser; no email delivery provider is needed.
- Guest sessions are tied to the browser. Players should use separate devices or browser profiles; clearing browser storage may lose that guest identity.
- The Who view receives the team scoreboard and that player's own identity/role.
- Grinches additionally receive their mission and the identities of their fellow Grinches.
- The host can see the roster but does not get other players' roles.
- Row Level Security blocks direct reads of other players' roles. The `get_my_game` function returns role details only for the signed-in player and returns the Grinch briefing only when that player's server-stored role is `grinch`.
- The host can distribute players and request random Grinch assignment; these assignments are performed in server-side PostgreSQL functions.
- The host can edit player names and teams, remove a player, and customize team names/colors. Roster changes that affect assignments clear roles so the host can safely assign them again.
- Room setup, roster, roles, and scores live in Supabase, not browser local storage.

The SQL schema is a starter implementation. Before public production use, add rate limits/abuse controls for guest account creation and room joins, review database policies, and test with separate Who, Grinch, and host devices.

## Current scope

This version includes game creation, team customization, join codes, server-side roster management, team distribution and role assignment, player-specific Who/Grinch views, and shared team prize totals. Challenge workflows, Grinch powers, voting, and score-changing actions are future milestones; any such actions should be implemented as server-validated database functions rather than client-side writes.
