import { defineStore } from "pinia";

import { fetchAddressBook } from "@/api/addressBook";
import { fetchConversationList } from "@/api/conversations";
import { fetchMockAddressBook, fetchMockConversationList, isMessageMockEnabled } from "@/mocks/messageWorkbench";
import type { AddressBookResponseApi } from "@/types/api/addressBook";
import type { ConversationListItemApi } from "@/types/api/conversation";
import { parseServerDateTime } from "@/utils/datetime";

const HIDDEN_RECENT_STORAGE_KEY = "claw-team:hidden-recent-conversations";

type HiddenRecentConversationMap = Record<string, string>;

export const useAddressBookStore = defineStore("addressBook", {
    state: () => ({
        loading: false,
        recentLoading: false,
        addressBook: null as AddressBookResponseApi | null,
        recentConversations: [] as ConversationListItemApi[],
        hiddenRecentConversationMap: loadHiddenRecentConversationMap(),
    }),
    getters: {
        instances: (state) => state.addressBook?.instances ?? [],
        groups: (state) => state.addressBook?.groups ?? [],
        visibleRecentConversations: (state) =>
            state.recentConversations.filter((item) => {
                const hiddenAt = state.hiddenRecentConversationMap[String(item.id)];
                if (!hiddenAt) {
                    return true;
                }
                if (!item.last_message_at) {
                    return false;
                }
                return parseServerDateTime(item.last_message_at).getTime() > new Date(hiddenAt).getTime();
            }),
    },
    actions: {
        async loadAddressBook() {
            this.loading = true;
            try {
                this.addressBook = isMessageMockEnabled() ? await fetchMockAddressBook() : await fetchAddressBook();
            } finally {
                this.loading = false;
            }
        },
        async loadRecentConversations() {
            this.recentLoading = true;
            try {
                this.recentConversations = isMessageMockEnabled()
                    ? await fetchMockConversationList()
                    : await fetchConversationList();
                this.reconcileHiddenRecentConversations();
            } finally {
                this.recentLoading = false;
            }
        },
        async loadAll() {
            this.loading = true;
            try {
                const [addressBook, recentConversations] = isMessageMockEnabled()
                    ? await Promise.all([fetchMockAddressBook(), fetchMockConversationList()])
                    : await Promise.all([fetchAddressBook(), fetchConversationList()]);
                this.addressBook = addressBook;
                this.recentConversations = recentConversations;
                this.reconcileHiddenRecentConversations();
            } finally {
                this.loading = false;
            }
        },
        async refreshRecentConversations() {
            this.recentConversations = isMessageMockEnabled()
                ? await fetchMockConversationList()
                : await fetchConversationList();
            this.reconcileHiddenRecentConversations();
        },
        hideRecentConversation(conversationId: number) {
            this.hiddenRecentConversationMap = {
                ...this.hiddenRecentConversationMap,
                [String(conversationId)]: new Date().toISOString(),
            };
            persistHiddenRecentConversationMap(this.hiddenRecentConversationMap);
        },
        reconcileHiddenRecentConversations() {
            let changed = false;
            const nextMap: HiddenRecentConversationMap = { ...this.hiddenRecentConversationMap };
            for (const item of this.recentConversations) {
                const key = String(item.id);
                const hiddenAt = nextMap[key];
                if (!hiddenAt || !item.last_message_at) {
                    continue;
                }
                if (parseServerDateTime(item.last_message_at).getTime() > new Date(hiddenAt).getTime()) {
                    delete nextMap[key];
                    changed = true;
                }
            }
            if (!changed) {
                return;
            }
            this.hiddenRecentConversationMap = nextMap;
            persistHiddenRecentConversationMap(this.hiddenRecentConversationMap);
        },
    },
});

function loadHiddenRecentConversationMap(): HiddenRecentConversationMap {
    if (typeof window === "undefined") {
        return {};
    }
    try {
        const raw = window.localStorage.getItem(HIDDEN_RECENT_STORAGE_KEY);
        if (!raw) {
            return {};
        }
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return {};
        }
        return parsed as HiddenRecentConversationMap;
    } catch {
        return {};
    }
}

function persistHiddenRecentConversationMap(value: HiddenRecentConversationMap) {
    if (typeof window === "undefined") {
        return;
    }
    window.localStorage.setItem(HIDDEN_RECENT_STORAGE_KEY, JSON.stringify(value));
}
