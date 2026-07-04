# GITS VPS, Home Server, And Mini ITX Build Report

Date: 2026-07-04

## Decision Summary

Rent a small dedicated server now, then repurpose the current Ryzen 7 3700X mini ITX PC as the permanent 24/7 GITS/HERMES server after the next desktop upgrade.

Recommended short-term host:

| Option             |                                         Specs |             Approx monthly cost | Why                                                        |
| ------------------ | --------------------------------------------: | ------------------------------: | ---------------------------------------------------------- |
| Hetzner EX44-1-LTD |       Core i5-13500, 64 GB RAM, 2x512 GB NVMe | EUR 57.30 / USD 72.10, no setup | Best temporary GITS/HERMES host if 1 TB raw disk is enough |
| Hetzner AX42-1-LTD | Ryzen 7 PRO 8700GE, 64 GB DDR5, 2x512 GB NVMe |   EUR 77.30 / USD 77.30 + setup | Better AMD platform, still compact cost                    |
| Hetzner EX63-1-LTD |     Core Ultra 7 265, 64 GB DDR5, 2x1 TB NVMe |  EUR 97.30 / USD 117.10 + setup | Pick this only if 1 TB usable RAID1 matters                |

Practical pick: **EX44-1-LTD**. It is cheap enough to use as a proving ground until Black Friday, and it has enough RAM/CPU/disk for GITS, HERMES, Tailscale, Telegram, multiple agent sessions, worktrees, logs, and small SQLite/Postgres services.

Skipped: AX102-class machines. 128 GB RAM and 2 TB+ NVMe are unnecessary if 1 TB is enough.

## YouTube VPS Workflow Takeaways

Source video: <https://www.youtube.com/watch?v=5nJUsgYWINE>

Relevant claims from the transcript:

- Run Claude Code directly on the VPS instead of on the laptop.
- Keep sessions alive with `tmux`.
- SSH from laptop, phone, tablet, or any owned device through Tailscale.
- Let long tasks run overnight without keeping a laptop awake.
- Deploy faster because the agent is already on the server.
- Use staging if other people depend on the app; production hot edits are solo-hacker territory.
- Have real backups before letting agents mutate code.
- Firewall public ingress, use Tailscale SSH, and expose web UI only inside the tailnet unless deliberately publishing it.
- Avoid gray-market model/token proxy services because prompts, source code, env vars, and secrets pass through infrastructure you do not control.

## Recommended GITS/HERMES Operating Model

Use the VPS/home server as the always-on control plane:

- **Tailscale SSH**: primary access path from every trusted device.
- **GITS**: web/control surface for Codex, Claude Code, OpenCode, Cursor, Delamain peers, worktrees, and verifier flows.
- **HERMES**: primary async brain/message interface once Telegram plumbing exists.
- **Telegram**: commands, approvals, status, failures, and "wake me up" messages.
- **SSH**: manual operator fallback.
- **Public web exposure**: none by default.

Minimal Telegram command surface:

- `status`
- `pause`
- `resume`
- `approve`
- `reject`
- `tail`
- `open task`

Do not make Telegram a raw shell. It should send typed operator commands into HERMES/GITS.

## Temporary VPS Setup

Target OS:

- Ubuntu 24.04 LTS or Debian 12.

Host layout:

```text
/srv/gits/repos
/srv/gits/worktrees
/srv/gits/runtime
/var/lib/gits
/var/log/gits
~/.gits/hermes
```

Baseline services:

- `tailscaled`
- `gits.service`
- `hermes.service`
- `ssh`, restricted to tailnet where possible
- `ufw` or `nftables`, default deny inbound
- `tmux` for manual long-running provider sessions

Backups:

- Daily repo/config/database snapshot.
- Off-box copy, e.g. Hetzner Storage Box, Backblaze B2, restic target, or another home machine.
- Include `~/.gits`, GITS state, HERMES config, SQLite databases, and deployment scripts.
- Do not rely on the server itself as the only backup.

## Repurposing The Current PC

Current system:

- Ryzen 7 3700X
- 32 GB DDR4-3200
- 1 TB SSD is enough for GITS/HERMES
- RTX 3080
- Mini ITX / NR200-class case

This is enough for the permanent GITS/HERMES box after the new desktop exists. GITS and HERMES mostly need CPU, RAM, disk, stable networking, and provider credentials. They do not need a high-end GPU unless you intentionally run local models.

Power estimate:

```text
50 W always on = 0.05 kW * 24 * 30 = 36 kWh/month
At EUR 0.20/kWh = about EUR 7.20/month
100 W always on = about EUR 14.40/month
```

Energy tuning:

- Enable BIOS C-states.
- Enable Ryzen Eco Mode or lower PPT.
- Remove the RTX 3080 if the machine can boot headless or with a tiny low-power display adapter.
- Use SSDs, not spinning disks, unless bulk storage is needed.
- Use an efficient PSU at low load.
- Run Linux headless, no desktop environment.
- Add a small UPS if HERMES becomes operationally important.

Case guidance:

- Keep the current NR200-class case until the server is stable.
- Measure idle power, thermals, and noise before shrinking the case.
- Smaller cases often make noise and thermals worse.
- Repurpose the NR200D/NR200-style case for the new gaming/dev build only if the old server gets a quieter smaller case without thermal compromises.

## RTX 3080 Reality Check

The RTX 3080 launched on September 17, 2020. As of July 4, 2026 it is about 5 years and 10 months old, not quite 7 years.

It is still useful:

- Good for 1440p gaming.
- Fine as a stopgap GPU in a new build.
- Fine for CUDA/dev work that fits in 10-12 GB VRAM.

It is showing age:

- Limited VRAM for newer games, local AI, and creator workloads.
- Much weaker ray tracing/path tracing than RTX 50-series.
- Higher idle/load power than ideal for a 24/7 server.

Recommendation: keep the RTX 3080 until Black Friday unless a good RTX 5080 deal appears. Do not put it in the permanent GITS/HERMES server if power saving matters.

## High-End Mini ITX Developer/Gaming Build

Monitor target: LG UltraGear 45GX950A-B, 44.5-inch OLED, 5120x2160 5K2K, 165 Hz, DisplayPort 2.1. That is about 11.06 million pixels per frame: 33% more pixels than 4K, 2.24x 3440x1440 ultrawide, and 3.68x 2560x1440.

For this monitor, the useful upgrade is CPU + platform + RAM first, then GPU when prices make sense. The RTX 3080 can still drive the monitor, but the Ryzen 7 3700X and 32 GB DDR4 are now the obvious bottleneck for high-refresh gaming, heavy browser/dev work, local services, and agent tooling.

### PCPartPicker-Style Shortlist

| Part              | Recommended pick                                      | Approx price        | Buy link / notes                                                                                                                                                                                                                                |
| ----------------- | ----------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CPU               | AMD Ryzen 9 9950X3D                                   | EUR 654-699         | [PcComponentes tray](https://www.pccomponentes.com/procesador-amd-ryzen-9-9950x3d-16-nucleos-4-3-ghz-base-5-7-ghz-turbo-tray) or [box](https://www.pccomponentes.com/procesador-amd-ryzen-9-9950x3d-4-3-5-7ghz-box). Best dev + gaming balance. |
| CPU value option  | AMD Ryzen 7 9800X3D                                   | EUR 457-467         | [PcComponentes](https://www.pccomponentes.com/procesador-amd-ryzen-7-9800x3d-4-7-5-2ghz). Better pure gaming value, weaker for heavy parallel dev.                                                                                              |
| Motherboard       | ASUS ROG Strix B850-I Gaming WiFi                     | EUR 372             | [PcComponentes](https://www.pccomponentes.com/placa-base-asus-rog-strix-b850-i-gaming-wifi). Mini ITX, AM5, WiFi 7, 2.5 GbE, 2x M.2, max 96 GB RAM per listing.                                                                                 |
| RAM               | Corsair Vengeance 96 GB, 2x48 GB, DDR5-6000 CL30 EXPO | EUR 559 when listed | [PcComponentes](https://www.pccomponentes.com/memoria-ram-corsair-vengeance-ddr5-96gb-2-x-48gb-ddr5-6000-cl30-36-36-76-140v-intel-xmp-amd-expo-grey). Sweet spot for mini ITX dev + gaming.                                                     |
| GPU now           | Reuse RTX 3080                                        | EUR 0               | Keep until RTX 5080/5090 pricing improves. This avoids wasting money before Black Friday.                                                                                                                                                       |
| GPU upgrade       | RTX 5080 16 GB, SFF-friendly model                    | EUR 1,388-1,500+    | [PcComponentes RTX 5080 listings](https://www.pccomponentes.com/tarjetas-graficas/geforce-rtx-5080/grafica-nvidia). Target near EUR 1,100-1,200 if possible.                                                                                    |
| GPU no-compromise | RTX 5090 32 GB, only if the exact card fits           | EUR 5,200-6,100+    | [PcComponentes RTX 5090 listings](https://www.pccomponentes.com/tarjetas-graficas/geforce-rtx-5090/grafica-nvidia). Bad value today, but best 5K2K + AI headroom.                                                                               |
| Primary SSD       | Samsung 990 Pro 4 TB or 990 EVO Plus 4 TB             | EUR 300-450+        | [990 Pro 4 TB](https://www.pccomponentes.com/disco-duro-samsung-990-pro-4tb-ssd-pcie-4-0-nvme-m-2) or [990 EVO Plus 4 TB](https://www.pccomponentes.com/disco-duro-samsung-990-evo-plus-4tb-disco-ssd-7250mb-s-nvme-pcie-5-0-x2-nvme-2-0-nand). |
| Air cooler        | Thermalright Phantom Spirit 120 SE                    | EUR 45-70           | 154 mm tall; fits NR200P's 155 mm air-cooler spec. Avoid the 157-160 mm variants.                                                                                                                                                               |
| AIO cooler        | Arctic Liquid Freezer III/III Pro 280                 | EUR 100-130         | Best cooling route for 9950X3D in NR200P if mounted correctly.                                                                                                                                                                                  |
| PSU               | Reuse Corsair Platinum 750 W only with RTX 3080       | EUR 0               | Fine for current GPU. Not the target PSU for RTX 5080/5090.                                                                                                                                                                                     |
| PSU upgrade       | Corsair SF1000 / SF1000L / equivalent ATX 3.x SFX     | EUR 215-250         | Required recommendation for RTX 5080/5090 headroom and native 12V-2x6/PCIe 5 cable.                                                                                                                                                             |
| Case              | Reuse Cooler Master NR200P                            | EUR 0               | Works for AM5 mini ITX, air cooling, and many GPUs. Must check exact GPU length/thickness and cable bend clearance.                                                                                                                             |

Expected total:

- **Stage 1, keep RTX 3080 + NR200P + SF750**: about **EUR 1,900-2,400**.
- **Stage 2, add RTX 5080 + SF1000**: about **EUR 3,500-4,200** total.
- **RTX 5090 build**: usually **EUR 7,000+** at current Spanish RTX 5090 pricing, and it may force a case/PSU/cooling rethink.

Recommended build for this use:

```text
CPU: AMD Ryzen 9 9950X3D
GPU: reuse RTX 3080 now; RTX 5080 later if price/fit are good
RAM: 96 GB DDR5-6000 CL30 EXPO
SSD: 4 TB fast NVMe
PSU: keep SF750 for RTX 3080; upgrade to SF1000 for RTX 5080/5090
Case: keep NR200P if the exact GPU fits
```

### CPU Benchmarks And Why The 3700X Feels Bottlenecked

| CPU             | Cores / threads | PassMark CPU Mark class | What changes vs Ryzen 7 3700X                                                                                |
| --------------- | --------------: | ----------------------: | ------------------------------------------------------------------------------------------------------------ |
| Ryzen 7 3700X   |          8 / 16 |               about 22k | Baseline. Fine, but dated for high-refresh 5K2K and heavy dev multitasking.                                  |
| Ryzen 7 9800X3D |          8 / 16 |               about 40k | Huge gaming uplift, very efficient, easier to cool.                                                          |
| Ryzen 9 9950X3D |         16 / 32 |               about 69k | Best all-round pick: high-end gaming plus much stronger compile, VM, container, and agent workload capacity. |

### GPU Benchmark Target For 5K2K

| GPU      |     VRAM |                Power class | Expected 5K2K role                                                                                              |
| -------- | -------: | -------------------------: | --------------------------------------------------------------------------------------------------------------- |
| RTX 3080 | 10-12 GB |                     ~320 W | Usable today, especially with DLSS, but VRAM and ray tracing are the weak spots.                                |
| RTX 5080 |    16 GB |  360 W, 850 W PSU guidance | The sensible upgrade target: roughly 50-70% faster than RTX 3080 in many 4K-class comparisons, plus DLSS 4/MFG. |
| RTX 5090 |    32 GB | 575 W, 1000 W PSU guidance | Best raw headroom for 5K2K, AI, and creator work, but current pricing and NR200P fit make it a bad default.     |

### Air Cooling Vs Water Cooling In The NR200P

| Cooling path                           | Fit                                   | Use it when                                                                                                            | Avoid it when                                                                                             |
| -------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Thermalright Phantom Spirit 120 SE air | Fits at 154 mm vs NR200P 155 mm limit | You want simple, cheap, reliable cooling with the mesh side panel. Great for 9800X3D and acceptable for tuned 9950X3D. | You want maximum 9950X3D all-core boost, silence under compile/render loads, or use tall RAM/fan offsets. |
| Noctua NH-U12A                         | Does **not** officially fit           | Only if you are willing to gamble or mod; it is 158 mm tall.                                                           | Normal build. NR200P official limit is 155 mm.                                                            |
| 280 mm AIO                             | Fits per NR200P radiator support      | Best option for 9950X3D in this case, especially if you want sustained dev workloads.                                  | You want the lowest maintenance, or the GPU/riser layout conflicts with side radiator placement.          |

Ponytail recommendation: **start with Phantom Spirit 120 SE + 9950X3D in Eco/PBO-tuned mode if you want simple**, or **use a 280 mm AIO if you know the machine will spend long periods compiling/rendering under load**.

### NR200P Fit Decision

Your NR200P works for this motherboard build:

- Mini ITX AM5 motherboard: yes.
- Corsair SF750/SF1000 SFX PSU: yes.
- Air cooling: yes, if the cooler is 155 mm or shorter.
- 280 mm AIO: yes, but layout matters.
- RTX 3080: already works.
- RTX 5080: likely, but buy an SFF-friendly model and check exact length/thickness.
- RTX 5090: not recommended in the original NR200P unless the exact model is confirmed to fit. Many partner cards exceed comfortable NR200P limits.

### PSU Decision

Your Corsair Platinum 750 W is not wasted:

- Keep it for the Stage 1 build with the RTX 3080.
- Do not plan an RTX 5080 build around it; NVIDIA/Corsair guidance is 850 W for RTX 5080.
- Do not use it for RTX 5090; NVIDIA lists 1000 W required system power for RTX 5090.
- Upgrade to a modern ATX 3.x SFX PSU when the GPU changes, preferably Corsair SF1000 or equivalent.

Buy threshold:

- Buy RTX 5080 if an NR200P-compatible model lands near EUR 1,100-1,200.
- Consider RTX 5090 only if pricing normalizes, you need 32 GB VRAM for AI/creator work, and you are willing to change case/PSU/cooling.
- Otherwise reuse the RTX 3080 and revisit the GPU after Black Friday.

## Black Friday Plan

1. Rent EX44-1-LTD now.
2. Build and harden the GITS/HERMES workflow on the VPS.
3. Buy the new mini ITX developer/gaming PC around Black Friday if CPU/GPU/RAM prices make sense.
4. Move the old Ryzen 7 3700X PC to permanent home-server duty.
5. Migrate GITS/HERMES from VPS to home server.
6. Keep offsite backups.
7. Cancel the VPS only after the home server has survived at least one week of real use.

## Sources

- NVIDIA RTX 3080 launch: <https://www.nvidia.com/en-us/geforce/news/introducing-rtx-30-series-graphics-cards/>
- NVIDIA RTX 5080 official page: <https://www.nvidia.com/en-us/geforce/graphics-cards/50-series/rtx-5080/>
- NVIDIA RTX 5090 official page: <https://www.nvidia.com/en-us/geforce/graphics-cards/50-series/rtx-5090/>
- AMD Ryzen 9 9950X3D official page: <https://www.amd.com/en/products/processors/desktops/ryzen/9000-series/amd-ryzen-9-9950x3d.html>
- LG UltraGear 45GX950A-B: <https://www.lg.com/us/monitors/lg-45gx950a-b-gaming-monitor>
- Cooler Master NR200P: <https://www.coolermaster.com/en-global/products/masterbox-nr200p.html>
- Thermalright Phantom Spirit 120 SE: <https://www.thermalright.com/product/phantom-spirit-120-se/>
- Noctua NH-U12A: <https://www.noctua.at/en/products/nh-u12a>
- Corsair RTX 5000-series PSU guidance: <https://help.corsair.com/hc/en-us/articles/32465644341265-What-Power-Supply-Unit-PSU-should-I-buy-for-my-Nvidia-RTX-5000-series-GPU>
- PcComponentes Ryzen 9 9950X3D: <https://www.pccomponentes.com/procesador-amd-ryzen-9-9950x3d-4-3-5-7ghz-box>
- PcComponentes Ryzen 7 9800X3D: <https://www.pccomponentes.com/procesador-amd-ryzen-7-9800x3d-4-7-5-2ghz>
- PcComponentes ASUS ROG Strix B850-I Gaming WiFi: <https://www.pccomponentes.com/placa-base-asus-rog-strix-b850-i-gaming-wifi>
- PcComponentes RTX 5080 listings: <https://www.pccomponentes.com/tarjetas-graficas/geforce-rtx-5080/grafica-nvidia>
- PcComponentes RTX 5090 listings: <https://www.pccomponentes.com/tarjetas-graficas/geforce-rtx-5090/grafica-nvidia>
- RTX 5080 vs RTX 3080 comparison: <https://www.xda-developers.com/i-compared-two-flagship-gpus-separated-by-half-a-decade-and-the-results-shocked-me/>
- RTX 5080 vs RTX 3080 aggregate: <https://technical.city/en/video/GeForce-RTX-3080-vs-GeForce-RTX-5080>
- RTX 5090 vs RTX 3080 4K comparison: <https://thepcenthusiast.com/nvidia-geforce-rtx-5090-vs-rtx-4090-vs-rtx-3080-ti-gpu/>
- Tailscale SSH: <https://tailscale.com/docs/features/tailscale-ssh>
- Tailscale Serve: <https://tailscale.com/docs/reference/tailscale-cli/serve>
- Hetzner 2026 price adjustment: <https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/>
- RTX 5080 EU price tracker: <https://bestvaluegpu.com/en-eu/history/new-and-used-rtx-5080-price-history-and-specs/>
- RTX 5090 US price tracker: <https://bestvaluegpu.com/history/new-and-used-rtx-5090-price-history-and-specs/>
- Corsair SF1000 EU listing: <https://www.corsair.com/eu/en/p/psu/cp-9020257-eu/sf-series-sf1000-fully-modular-80-plus-platinum-sfx-power-supply-eu-cp-9020257-eu>
- Fractal Terra product page: <https://www.fractal-design.com/products/cases/terra/terra/>
- ASUS ROG Strix X870-I product page: <https://rog.asus.com/motherboards/rog-strix/rog-strix-x870-i-gaming-wifi/>
