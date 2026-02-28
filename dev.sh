#!/bin/sh

printf '\033[1;35m\n'
printf '  ┌──────────────────────────────────────────────────────────┐\n'
printf '  │               TankBet Dev Environment                   │\n'
printf '  ├──────────────────────────────────────────────────────────┤\n'
printf '  │  Frontend  →  http://localhost:5173                      │\n'
printf '  │  Backend   →  http://localhost:3001                      │\n'
printf '  │  Stripe    →  localhost:3001/api/webhooks/stripe         │\n'
printf '  │  Logs      →  ./logs/{web,backend,stripe,browser}.log    │\n'
printf '  └──────────────────────────────────────────────────────────┘\n'
printf '\033[0m\n'

rm -f .overmind.sock
overmind start -f Procfile.dev
