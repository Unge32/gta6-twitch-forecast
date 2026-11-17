[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/Unge32/gta6-twitch-forecast/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/Unge32/gta6-twitch-forecast/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)

Entry for [make.fun's "Forecast GTA VI's launch-day Twitch viewers hour by hour" bounty](https://make.fun/bounty/gta6-twitch-ccu-forecast-01) ($250 in USDC).

# GTA VI launch-day Twitch forecast

Entry for make.fun `gta6-twitch-ccu-forecast-01`: forecast how many people watch
Grand Theft Auto VI live on Twitch in each hour of its release day, 2026-11-19
(UTC), as five quantiles (5%, 25%, 50%, 75%, 95%) per hour for hours 2–24.

## Program

`main.ts` — Node 22+, standard library only, no network, no randomness.
Run: `MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts`.
It reads every `*.in` in the input directory and writes one `<id>.out` per case:
`{"hours": [{"hour": 2, "q": [q05, q25, q50, q75, q95]}, …]}` (23 rows).

## Method

A launch day on Twitch has a shape: viewers dip in the small hours (01:00–04:00
UTC — Europe asleep, the US not yet unlocked), jump when the US east coast
unlocks at 05:00 UTC, and peak in the US evening. That shape depends on how big
the launch already is at hour 1: the bigger the hour-1 print, the flatter the
day, because hour 1 already holds most of the audience. In the case files the
two biggest past launches (ELDEN RING, Cyberpunk 2077, ~850k viewers at hour 1)
barely grew at all after hour 1, while small ones grew several-fold by evening
(the correlation between log hour-1 size and the evening log-ratio is about
−0.9).

So for each hour h = 2..24 the program fits, over the case's own comparables
(past big launches with a full release day), a straight line in log space:

    ln(viewers_h / viewers_1) = a_h + b_h * ln(viewers_1)

fitted only on comparables whose hour-1 print is at least 10,000 viewers
(small categories are noise at hour 1 and would bend the line). The forecast
median for hour h is hour 1's print times exp(a_h + b_h * ln(p1)), and the
spread is the line's residual scatter:

    q_tau(h) = p1 * exp(mu_h + z_tau * sigma_h),
    z = (-1.645, -0.674, 0, 0.674, 1.645)

The size fed to the line is clamped to the sizes it was fitted on, so a launch
bigger than any comparable is forecast like the biggest comparable instead of
extrapolating the line past the data. Where an hour has fewer than 5 fitted
launches, the program falls back to that hour's median log-ratio and scatter
over the same comparables; where the case holds no usable comparables at all,
it falls back to a flat persistence forecast with a spread that widens like a
random walk (0.15 * sqrt(h − 1) log units). All quantiles are rounded to 2
decimals, clamped to (0, 1e9], and non-decreasing by construction.

## Validation (practice cases, scored locally against SullyGnome's hourly counts)

The practice answers are not in the kit (they are sealed on the server), so the
losses below were scored with a local harness that replays the contest's
pinball loss on the log scale, using the same public SullyGnome source the kit
names in `input/NOTICE.txt` (the "Average viewers" dataset, verified to match
each case's hour-1 print and history exactly). Mean pinball loss over the four
practice cases:

| case | game | hour-1 print | this entry | house baseline |
|------|------|-------------|-----------|----------------|
| p00 | Marvel's Wolverine | 23,357 | 0.3006 | 0.7437 |
| p01 | Red Dead Redemption 2 | 116,550 | 0.2107 | 0.2868 |
| p02 | God of War Ragnarök | 269,517 | 0.1530 | 0.2146 |
| p03 | Marvel's Spider-Man 2 | 119,087 | 0.1896 | 0.3033 |
| **mean** | | | **0.2135** | **0.3871** |

The baseline's 0.3871 reproduces the kit's stated practice figure (~0.387),
which validates the local scorer. Typical miss (median) 26.8–69.1% per case;
90% coverage 0.87–1.00 (mean ≈ 0.93, near the honest 0.90). Every output is
valid (23 rows, hours 2–24, five non-decreasing quantiles in (0, 1e9], under
65,536 bytes), two runs on the same case are byte-identical, and each run
takes ~0.25 s, far under the 8 s cap.

Caveat: practice is graded on past launches anyone can look up and pays
nothing; a practice score is no guide to the final, where the only case is
GTA VI itself on 2026-11-19.

## Files

- `main.ts` — the forecaster (the entrypoint; written for this entry)
- `README.md` — this file
- `LICENSE` — MIT (from the kit's starter)
