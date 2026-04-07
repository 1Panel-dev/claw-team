/**
 * 这个文件提供消息模块的前端本地模拟数据。
 *
 * 目的不是替代真实后端，而是让消息页在没有联调约束时，
 * 也能直接演示：
 * 1. 通讯录
 * 2. 最近会话
 * 3. 单聊消息流
 * 4. Agent 分段回复和状态变化
 */
import type { AddressBookResponseApi } from "@/types/api/addressBook";
import type {
    ConversationListItemApi,
    ConversationMessagesResponseApi,
    ConversationReadApi,
    DispatchReadApi,
    MessageReadApi,
} from "@/types/api/conversation";

type MockConversation = ConversationReadApi & {
    display_title: string;
    order: number[];
    dispatchOrder: number[];
};

const MOCK_INSTANCE_ID = 9001;
const MOCK_AGENT_ID = 9101;
const MOCK_GROUP_ID = 9201;
const MOCK_AGENT_NOVA_ID = 9102;

let messageSeq = 1000;
let dispatchSeq = 3000;
let eventSeq = 5000;

const mockAgents = [
    {
        id: MOCK_AGENT_ID,
        agent_key: "mia-pm",
        cs_id: "CSA-9101",
        display_name: "Mia 产品经理",
        role_name: "产品协作 Agent",
        enabled: true,
    },
    {
        id: MOCK_AGENT_NOVA_ID,
        agent_key: "nova-engineer",
        cs_id: "CSA-9102",
        display_name: "Nova 工程师",
        role_name: "实现建议 Agent",
        enabled: true,
    },
    {
        id: 9103,
        agent_key: "lyra-ops",
        cs_id: "CSA-9103",
        display_name: "Lyra 运维",
        role_name: "发布巡检 Agent",
        enabled: true,
    },
    {
        id: 9104,
        agent_key: "aria-designer",
        cs_id: "CSA-9104",
        display_name: "Aria 设计师",
        role_name: "界面审阅 Agent",
        enabled: true,
    },
    {
        id: 9105,
        agent_key: "echo-qa",
        cs_id: "CSA-9105",
        display_name: "Echo 测试",
        role_name: "验证回归 Agent",
        enabled: true,
    },
    {
        id: 9106,
        agent_key: "kai-support",
        cs_id: "CSA-9106",
        display_name: "Kai 客服",
        role_name: "客户沟通 Agent",
        enabled: true,
    },
    {
        id: 9107,
        agent_key: "iris-data",
        cs_id: "CSA-9107",
        display_name: "Iris 数据分析",
        role_name: "数据洞察 Agent",
        enabled: true,
    },
    {
        id: 9108,
        agent_key: "leo-architect",
        cs_id: "CSA-9108",
        display_name: "Leo 架构师",
        role_name: "系统设计 Agent",
        enabled: true,
    },
] as const;

const addressBook: AddressBookResponseApi = {
    instances: [
        {
            id: MOCK_INSTANCE_ID,
            name: "Demo OpenClaw",
            status: "active",
            agents: [...mockAgents],
        },
    ],
    groups: [],
};

const conversations = new Map<number, MockConversation>();
const messages = new Map<number, MessageReadApi[]>();
const dispatches = new Map<number, DispatchReadApi[]>();

seed();

export function isMessageMockEnabled() {
    return import.meta.env.VITE_MESSAGE_MOCK === "true";
}

export async function fetchMockAddressBook(): Promise<AddressBookResponseApi> {
    return structuredClone(addressBook);
}

export async function fetchMockConversationList(): Promise<ConversationListItemApi[]> {
    return Array.from(conversations.values())
        .map((conversation) => toConversationListItem(conversation.id))
        .sort((a, b) => {
            const left = a.last_message_at ?? a.updated_at;
            const right = b.last_message_at ?? b.updated_at;
            return right.localeCompare(left);
        });
}

export async function createMockDirectConversation(instanceId: number, agentId: number): Promise<ConversationReadApi> {
    const existing = Array.from(conversations.values()).find(
        (item) => item.type === "direct" && item.direct_instance_id === instanceId && item.direct_agent_id === agentId,
    );
    if (existing) {
        return structuredClone(existing);
    }

    const agent = addressBook.instances
        .find((item) => item.id === instanceId)
        ?.agents.find((item) => item.id === agentId);

    const id = nextConversationId();
    const now = nowIso();
    const conversation: MockConversation = {
        id,
        type: "direct",
        title: agent?.display_name ?? "新会话",
        group_id: null,
        direct_instance_id: instanceId,
        direct_agent_id: agentId,
        created_at: now,
        updated_at: now,
        display_title: agent?.display_name ?? "新会话",
        order: [],
        dispatchOrder: [],
    };
    conversations.set(id, conversation);
    messages.set(id, []);
    dispatches.set(id, []);
    return structuredClone(conversation);
}

export async function createMockGroupConversation(groupId: number): Promise<ConversationReadApi> {
    const existing = Array.from(conversations.values()).find((item) => item.type === "group" && item.group_id === groupId);
    if (existing) {
        return structuredClone(existing);
    }
    const group = addressBook.groups.find((item) => item.id === groupId);
    const id = nextConversationId();
    const now = nowIso();
    const conversation: MockConversation = {
        id,
        type: "group",
        title: group?.name ?? "模拟群聊",
        group_id: groupId,
        direct_instance_id: null,
        direct_agent_id: null,
        created_at: now,
        updated_at: now,
        display_title: group?.name ?? "模拟群聊",
        order: [],
        dispatchOrder: [],
    };
    conversations.set(id, conversation);
    messages.set(id, []);
    dispatches.set(id, []);
    return structuredClone(conversation);
}

export async function fetchMockConversationMessages(
    conversationId: number,
    params?: {
        messageAfter?: string | null;
        dispatchAfter?: string | null;
        beforeMessageId?: string | null;
        limit?: number;
        includeDispatches?: boolean;
    },
): Promise<ConversationMessagesResponseApi> {
    const conversation = conversations.get(conversationId);
    if (!conversation) {
        throw new Error("模拟会话不存在");
    }
    const conversationMessages = messages.get(conversationId) ?? [];
    const conversationDispatches = dispatches.get(conversationId) ?? [];

    let nextMessages = sliceAfterCursor(conversationMessages, params?.messageAfter);
    if (params?.beforeMessageId) {
        const anchorIndex = conversationMessages.findIndex((item) => item.id === params.beforeMessageId);
        const endIndex = anchorIndex >= 0 ? anchorIndex : conversationMessages.length;
        const limit = params.limit ?? 100;
        nextMessages = conversationMessages.slice(Math.max(0, endIndex - limit), endIndex);
    } else if (params?.limit) {
        nextMessages = conversationMessages.slice(-params.limit);
    }

    const nextDispatches = params?.includeDispatches === false
        ? []
        : sliceAfterCursor(conversationDispatches, params?.dispatchAfter);

    return {
        conversation: structuredClone(conversation),
        messages: structuredClone(nextMessages),
        dispatches: structuredClone(nextDispatches),
        next_message_cursor: conversationMessages.at(-1)?.id ?? null,
        next_dispatch_cursor: conversationDispatches.at(-1)?.id ?? null,
        has_more_messages: nextMessages.length < conversationMessages.length,
        oldest_loaded_message_id: nextMessages[0]?.id ?? null,
    };
}

export async function sendMockConversationMessage(
    conversationId: number,
    payload: { content: string; mentions?: string[]; useDedicatedDirectSession?: boolean },
): Promise<MessageReadApi> {
    const conversation = conversations.get(conversationId);
    if (!conversation) {
        throw new Error("模拟会话不存在");
    }

    const userMessage = createMessage({
        conversationId,
        senderType: "user",
        senderLabel: "你",
        content: payload.content.trim(),
        status: "completed",
    });
    pushMessage(conversationId, userMessage);

    const targetAgentName =
        payload.mentions?.[0] === "nova-engineer"
            ? "Nova 工程师"
            : conversation.direct_agent_id === MOCK_AGENT_NOVA_ID
              ? "Nova 工程师"
              : "Mia 产品经理";
    const replyDraft = buildMockReply(payload.content, targetAgentName);
    const dispatch = createDispatch({
        conversationId,
        agentId: targetAgentName === "Nova 工程师" ? MOCK_AGENT_NOVA_ID : MOCK_AGENT_ID,
        status: "accepted",
    });
    pushDispatch(conversationId, dispatch);

    const replyMessageId = nextMessageId();
    window.setTimeout(() => {
        updateDispatch(conversationId, dispatch.id, "streaming");
        const replyMessage = createMessage({
            id: replyMessageId,
            conversationId,
            senderType: "agent",
            senderLabel: targetAgentName,
            content: replyDraft.chunk1,
            status: "streaming",
        });
        pushMessage(conversationId, replyMessage);
    }, 500);

    window.setTimeout(() => {
        updateMessage(conversationId, replyMessageId, {
            content: `${replyDraft.chunk1}\n\n${replyDraft.chunk2}`,
            status: "streaming",
        });
    }, 1300);

    window.setTimeout(() => {
        updateDispatch(conversationId, dispatch.id, "completed");
        updateMessage(conversationId, replyMessageId, {
            content: `${replyDraft.chunk1}\n\n${replyDraft.chunk2}\n\n${replyDraft.chunk3}`,
            status: "completed",
        });
    }, 2200);

    return structuredClone(userMessage);
}

function seed() {
    seedDirectConversation(7001, MOCK_AGENT_ID, "Mia 产品经理", [
        {
            senderType: "agent",
            senderLabel: "Mia 产品经理",
            content: "你好，我是 Mia。你可以把我当作一个偏产品和协作视角的 Agent，我们可以先用这条模拟会话看看消息界面效果。",
            status: "completed",
            createdAt: shiftIso(-8),
        },
        {
            senderType: "user",
            senderLabel: "你",
            content: "请先帮我看看聊天界面的展示效果。",
            status: "completed",
            createdAt: shiftIso(-7),
        },
        {
            senderType: "agent",
            senderLabel: "Mia 产品经理",
            content: "可以。我会模拟正常回复、流式回复和状态变化。你现在直接发一条消息，我会继续按真实聊天的样子回给你。",
            status: "completed",
            createdAt: shiftIso(-6),
        },
    ]);

    seedDirectConversation(7002, MOCK_AGENT_NOVA_ID, "Nova 工程师", [
        {
            senderType: "agent",
            senderLabel: "Nova 工程师",
            content: [
                "我把登录页交互细节又收了一版，整理成了一个小表：",
                "",
                "| 项目 | 结果 |",
                "| --- | --- |",
                "| 按钮悬停 | 已统一 |",
                "| 输入框高度 | 已对齐 |",
                "| 移动端交互 | 待二次确认 |",
            ].join("\n"),
            status: "completed",
            createdAt: shiftIso(-18),
        },
    ]);
    seedDirectConversation(7003, 9103, "Lyra 运维", [
        {
            senderType: "agent",
            senderLabel: "Lyra 运维",
            content: [
                "预发环境巡检正常，下面是本次执行摘要：",
                "",
                "[[tool:预发巡检|completed|共检查 12 项，Nginx、SQLite 备份、磁盘空间均正常]]",
            ].join("\n"),
            status: "completed",
            createdAt: shiftIso(-39),
        },
    ]);
    seedDirectConversation(7004, 9104, "Aria 设计师", [
        {
            senderType: "agent",
            senderLabel: "Aria 设计师",
            content: [
                "聊天列表建议再压轻一点，现在已经比后台风格顺很多了。",
                "",
                "> 重点不是加更多装饰，而是减少后台式线条和卡片感。",
                "",
                "- 会话项可以更紧凑",
                "- 顶部工具条继续弱化",
                "- 输入区像 IM 一样固定在底部",
            ].join("\n"),
            status: "completed",
            createdAt: shiftIso(-83),
        },
    ]);
    seedDirectConversation(7005, 9105, "Echo 测试", [
        {
            senderType: "agent",
            senderLabel: "Echo 测试",
            content: [
                "我补了一轮回归，消息轮询和任务创建这两条链都通过了。",
                "",
                "[[attachment:回归检查清单.xlsx|application/vnd.openxmlformats-officedocument.spreadsheetml.sheet|https://example.com/files/checklist.xlsx]]",
            ].join("\n"),
            status: "completed",
            createdAt: shiftIso(-125),
        },
    ]);
    seedDirectConversation(7006, 9106, "Kai 客服", [
        {
            senderType: "agent",
            senderLabel: "Kai 客服",
            content: "今天客户最在意的是消息页体验，希望更像桌面 IM，不要太像后台。",
            status: "completed",
            createdAt: shiftIso(-180),
        },
    ]);
    seedDirectConversation(7007, 9107, "Iris 数据分析", [
        {
            senderType: "agent",
            senderLabel: "Iris 数据分析",
            content: "最近会话列表如果只显示一个示例，会让左侧看起来特别空。",
            status: "completed",
            createdAt: shiftIso(-360),
        },
    ]);
    seedDirectConversation(7008, 9108, "Leo 架构师", [
        {
            senderType: "agent",
            senderLabel: "Leo 架构师",
            content: [
                "我建议把消息模块继续当成独立工作区来收，不要让顶部导航抢存在感。",
                "",
                "```ts",
                "const messageWorkspace = {",
                "  sidebar: 'contacts',",
                "  content: 'conversation',",
                "  footer: 'composer',",
                "};",
                "```",
            ].join("\n"),
            status: "completed",
            createdAt: shiftIso(-640),
        },
    ]);
}

function seedDirectConversation(
    conversationId: number,
    agentId: number,
    title: string,
    seededMessages: Array<{
        senderType: string;
        senderLabel: string;
        content: string;
        status: string;
        createdAt: string;
    }>,
) {
    const conversation: MockConversation = {
        id: conversationId,
        type: "direct",
        title,
        group_id: null,
        direct_instance_id: MOCK_INSTANCE_ID,
        direct_agent_id: agentId,
        created_at: seededMessages[0]?.createdAt ?? nowIso(),
        updated_at: seededMessages.at(-1)?.createdAt ?? nowIso(),
        display_title: title,
        order: [],
        dispatchOrder: [],
    };
    conversations.set(conversationId, conversation);
    messages.set(conversationId, []);
    dispatches.set(conversationId, []);

    for (const message of seededMessages) {
        pushMessage(
            conversationId,
            createMessage({
                conversationId,
                senderType: message.senderType,
                senderLabel: message.senderLabel,
                content: message.content,
                status: message.status,
                createdAt: message.createdAt,
            }),
        );
    }
}

function toConversationListItem(conversationId: number): ConversationListItemApi {
    const conversation = conversations.get(conversationId)!;
    const conversationMessages = messages.get(conversationId) ?? [];
    const lastMessage = conversationMessages.at(-1) ?? null;
    const group = conversation.group_id ? addressBook.groups.find((item) => item.id === conversation.group_id) : null;
    const instance = conversation.direct_instance_id
        ? addressBook.instances.find((item) => item.id === conversation.direct_instance_id)
        : null;
    const agent = instance?.agents.find((item) => item.id === conversation.direct_agent_id) ?? null;

    return {
        id: conversation.id,
        type: conversation.type,
        title: conversation.title,
        group_id: conversation.group_id,
        direct_instance_id: conversation.direct_instance_id,
        direct_agent_id: conversation.direct_agent_id,
        created_at: conversation.created_at,
        updated_at: conversation.updated_at,
        display_title: conversation.display_title,
        group_name: group?.name ?? null,
        instance_name: instance?.name ?? null,
        agent_display_name: agent?.display_name ?? null,
        last_message_id: lastMessage?.id ?? null,
        last_message_preview: lastMessage?.content ?? null,
        last_message_sender_type: lastMessage?.sender_type ?? null,
        last_message_sender_label: lastMessage?.sender_label ?? null,
        last_message_at: lastMessage?.updated_at ?? null,
        last_message_status: lastMessage?.status ?? null,
    };
}

function createMessage(input: {
    id?: string;
    conversationId: number;
    senderType: string;
    senderLabel: string;
    content: string;
    status: string;
    createdAt?: string;
}): MessageReadApi {
    const createdAt = input.createdAt ?? nowIso();
    return {
        id: input.id ?? nextMessageId(),
        conversation_id: input.conversationId,
        sender_type: input.senderType,
        sender_label: input.senderLabel,
        content: input.content,
        status: input.status,
        created_at: createdAt,
        updated_at: createdAt,
    };
}

function createDispatch(input: { conversationId: number; agentId: number; status: string }): DispatchReadApi {
    const createdAt = nowIso();
    return {
        id: `dispatch_mock_${++dispatchSeq}`,
        message_id: `msg_dispatch_ref_${dispatchSeq}`,
        conversation_id: input.conversationId,
        instance_id: MOCK_INSTANCE_ID,
        agent_id: input.agentId,
        dispatch_mode: "direct",
        channel_message_id: `channel_mock_${dispatchSeq}`,
        channel_trace_id: `trace_mock_${++eventSeq}`,
        session_key: `mock:conversation:${input.conversationId}:agent:${input.agentId}`,
        status: input.status,
        error_message: null,
        created_at: createdAt,
        updated_at: createdAt,
    };
}

function pushMessage(conversationId: number, message: MessageReadApi) {
    const list = messages.get(conversationId) ?? [];
    list.push(message);
    messages.set(conversationId, list);
    touchConversation(conversationId, message.updated_at);
}

function pushDispatch(conversationId: number, dispatch: DispatchReadApi) {
    const list = dispatches.get(conversationId) ?? [];
    list.push(dispatch);
    dispatches.set(conversationId, list);
    touchConversation(conversationId, dispatch.updated_at);
}

function updateMessage(conversationId: number, messageId: string, patch: Partial<MessageReadApi>) {
    const list = messages.get(conversationId) ?? [];
    const target = list.find((item) => item.id === messageId);
    if (!target) {
        return;
    }
    Object.assign(target, patch, { updated_at: nowIso() });
    touchConversation(conversationId, target.updated_at);
}

function updateDispatch(conversationId: number, dispatchId: string, status: string) {
    const list = dispatches.get(conversationId) ?? [];
    const target = list.find((item) => item.id === dispatchId);
    if (!target) {
        return;
    }
    target.status = status;
    target.updated_at = nowIso();
    touchConversation(conversationId, target.updated_at);
}

function touchConversation(conversationId: number, updatedAt: string) {
    const conversation = conversations.get(conversationId);
    if (!conversation) {
        return;
    }
    conversation.updated_at = updatedAt;
}

function sliceAfterCursor<T extends { id: string }>(items: T[], cursor?: string | null) {
    if (!cursor) {
        return items;
    }
    const index = items.findIndex((item) => item.id === cursor);
    return index >= 0 ? items.slice(index + 1) : items;
}

function buildMockReply(userContent: string, agentName: string) {
    return {
        chunk1: `${agentName} 已收到你的消息。`,
        chunk2: `如果只看界面效果，这条回复会先以“回复中”的状态出现，然后逐步补全内容。你刚才输入的是：“${userContent}”。`,
        chunk3: "后续我们还可以继续微调气泡宽度、状态标签、时间样式和滚动体验。",
    };
}

function nextConversationId() {
    return Math.max(...Array.from(conversations.keys()), 7000) + 1;
}

function nextMessageId() {
    return `msg_mock_${++messageSeq}`;
}

function nowIso() {
    return new Date().toISOString();
}

function shiftIso(minutesAgo: number) {
    return new Date(Date.now() + minutesAgo * 60_000).toISOString();
}
