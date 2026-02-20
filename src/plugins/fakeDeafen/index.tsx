/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { Menu } from "@webpack/common";

export let fakeD = false;

function deafen() {
    (document.querySelector('[aria-label="Deafen"]') as HTMLElement)?.click();
}

const settings = definePluginSettings({
    mute: {
        type: OptionType.BOOLEAN,
        description: "Keep mute state when fake deafened",
        default: true
    },
    deafen: {
        type: OptionType.BOOLEAN,
        description: "Send deafen state to server",
        default: true
    }
});

export default definePlugin({
    name: "FakeDeafen",
    description: "Appear deafened to others while still being able to hear them. Use /fd to toggle",
    authors: [Devs.jewdev],

    contextMenus: {
        "audio-device-context"(children, data) {
            if (!data?.renderOutputDevices) return;

            if (children.some(c => c?.props?.id === "fake-deafen-toggle")) return;

            children.push(
                <Menu.MenuCheckboxItem
                    id="fake-deafen-toggle"
                    label={`Fake Deafen 𓉘 ${fakeD ? "ON" : "OFF"} 𓉝 `}
                    checked={fakeD}
                    action={() => {
                        fakeD = !fakeD;
                        deafen();
                        setTimeout(deafen, 250);
                    }}
                />
            );
        }
    },

    patches: [
        {
            find: "}voiceStateUpdate(",
            replacement: {
                match: /self_mute:([^,]+),self_deaf:([^,]+),self_video:([^,]+)/,
                replace: "self_mute:$self.toggle($1, 'mute'),self_deaf:$self.toggle($2, 'deaf'),self_video:$self.toggle($3, 'video')"
            }
        }
    ],

    settings,

    commands: [
        {
            name: "fd",
            description: "Toggle fake deafen",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (_, ctx) => {
                fakeD = !fakeD;
                deafen();
                setTimeout(deafen, 250);

                sendBotMessage(ctx.channel.id, {
                    content: fakeD ? "🔴 Fake deafen: ON" : "⚪ Fake deafen: OFF"
                });
            }
        }
    ],

    toggle: (au: any, what: string) => {
        if (fakeD === false)
            return au;
        else
            switch (what) {
                case "mute": return settings.store.mute;
                case "deaf": return settings.store.deafen;
                case "video": return au;
            }
    }
});
