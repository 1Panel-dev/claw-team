/**
 * 这是本地补充的 OpenClaw SDK 类型声明。
 * 作用是让当前仓库在没有真实官方类型包的情况下也能完成类型检查和构建。
 */
declare module "openclaw/plugin-sdk/core" {
    export type OpenClawConfig = any;

    // 这里只保留当前项目实际用到的最小接口集合。
    export type ChannelPlugin<TResolvedAccount = any> = {
        id: string;
        meta?: {
            id: string;
            label: string;
            selectionLabel?: string;
            docsPath?: string;
            blurb?: string;
            aliases?: string[];
        };

        capabilities?: { chatTypes?: Array<"direct" | "group"> };

        config: {
            listAccountIds: (cfg: OpenClawConfig) => string[];
            resolveAccount: (cfg: OpenClawConfig, accountId?: string) => TResolvedAccount;
        };

        outbound: {
            deliveryMode: "direct" | "broadcast";
            sendText: (args: any) => Promise<any>;
        };
    };

    export type OpenClawPluginApi = {
        config: OpenClawConfig;
        logger?: {
            info: Function;
            warn: Function;
            error: Function;
            debug?: Function;
        };
        registrationMode?: "full" | "setup";
        runtime?: any;

        // registerChannel/registerHttpRoute 是当前插件最关键的两个宿主扩展点。
        registerChannel: (args: { plugin: ChannelPlugin<any> }) => void;
        registerHttpRoute: (args: {
            path: string;
            auth: "gateway" | "plugin";
            match?: "exact" | "prefix";
            replaceExisting?: boolean;
            handler: (req: any, res: any) => Promise<boolean> | boolean;
        }) => void;
    };

    export const emptyPluginConfigSchema: any;

    // defineChannelPluginEntry 的声明也按当前项目实际用法做了放宽。
    export function defineChannelPluginEntry<TPlugin extends ChannelPlugin<any>>(args: {
        id: string;
        name: string;
        description: string;
        plugin?: TPlugin;
        configSchema?: any;
        setRuntime?: (runtime: any) => void;
        registerFull?: (api: OpenClawPluginApi) => void;
    }): {
        id: string;
        name: string;
        description: string;
        configSchema: any;
        register: (api: OpenClawPluginApi) => void;
    };

    export const DEFAULT_ACCOUNT_ID: string;
    export function normalizeAccountId(accountId?: string): string;
}
