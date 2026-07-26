# 第三方资产署名

本项目代码之外使用的美术/音频资产及其许可，全部列于此。
文件位置：`packages/client/public/sfx/`

## 需要署名（CC-BY）

| 文件 | 原作 | 作者 | 许可 |
| --- | --- | --- | --- |
| `tire_skid.wav` | Car tire squeal skid loop | Iwan Gabovitch (qubodup) | [CC-BY 3.0](https://creativecommons.org/licenses/by/3.0/) |

> 上述文件为满足本项目采样率需求，已从 96 kHz/24-bit 重采样为 44.1 kHz/16-bit，
> 内容未作其他修改。CC-BY 3.0 允许改编，改编事实在此声明。

## 无需署名（CC0 / 公有领域）

以下文件均为 CC0 1.0，署名非强制，此处记录仅为可追溯来源。

| 文件 | 来源 | 许可 |
| --- | --- | --- |
| `engine_low.wav` `engine_mid.wav` `engine_high.wav` | OpenGameArt 引擎循环采样 | CC0 1.0 |
| `engine_start.ogg` | OpenGameArt 车辆音效包 | CC0 1.0 |
| `handbrake.ogg` | OpenGameArt 车辆音效包 | CC0 1.0 |
| `hit_light.ogg` `hit_medium.ogg` `hit_heavy.ogg` | Kenney Impact Sounds | CC0 1.0 |
| `land.ogg` | Kenney Impact Sounds | CC0 1.0 |
| `checkpoint.ogg` `lap.ogg` `finish.ogg` | Kenney Interface Sounds | CC0 1.0 |
| `countdown.ogg` `go.ogg` | Kenney Interface Sounds | CC0 1.0 |
| `fall.ogg` `ui_click.ogg` | Kenney Interface Sounds | CC0 1.0 |

Kenney 资产包：<https://kenney.nl/assets> — 包内 `License.txt` 明确为 CC0 1.0
Universal，允许商用、无需署名。

## 引擎音说明

`engine_low/mid/high` 是同一段采样的三个音高档，运行时按归一化 RPM 交叉淡化，
并叠加 ±15% `playbackRate` 微调，因此三档之间无音色跳变。归一化用各车的
`config.engine.maxSpeedKmh`，慢车和快车的声音行程一致。
