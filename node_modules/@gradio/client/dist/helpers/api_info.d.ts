import type { Status } from "../types";
import type { ApiData, ApiInfo, Config, JsApiData } from "../types";
export declare const RE_SPACE_NAME: RegExp;
export declare const RE_SPACE_DOMAIN: RegExp;
export declare function process_endpoint(app_reference: string, hf_token?: `hf_${string}`): Promise<{
    space_id: string | false;
    host: string;
    ws_protocol: "ws" | "wss";
    http_protocol: "http:" | "https:";
}>;
export declare function transform_api_info(api_info: ApiInfo<ApiData>, config: Config, api_map: Record<string, number>): ApiInfo<JsApiData>;
export declare function get_type(type: {
    type: any;
    description: string;
}, component: string, serializer: string, signature_type: "return" | "parameter"): string | undefined;
export declare function get_description(type: {
    type: any;
    description: string;
}, serializer: string): string;
export declare function handle_message(data: any, last_status: Status["stage"]): {
    type: "hash" | "data" | "update" | "complete" | "generating" | "log" | "none" | "heartbeat" | "unexpected_error";
    data?: any;
    status?: Status;
};
//# sourceMappingURL=api_info.d.ts.map