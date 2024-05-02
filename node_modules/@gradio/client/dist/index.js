var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => {
  __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
  return value;
};
var fn = new Intl.Collator(0, { numeric: 1 }).compare;
function semiver$1(a, b, bool) {
  a = a.split(".");
  b = b.split(".");
  return fn(a[0], b[0]) || fn(a[1], b[1]) || (b[2] = b.slice(2).join("."), bool = /[.-]/.test(a[2] = a.slice(2).join(".")), bool == /[.-]/.test(b[2]) ? fn(a[2], b[2]) : bool ? -1 : 1);
}
const CONFIG_URL = "config";
const API_INFO_URL = "info";
const SPACE_FETCHER_URL = "https://gradio-space-api-fetcher-v2.hf.space/api";
const QUEUE_FULL_MSG = "This application is too busy. Keep trying!";
const BROKEN_CONNECTION_MSG = "Connection errored out.";
function resolve_root(base_url, root_path, prioritize_base) {
  if (root_path.startsWith("http://") || root_path.startsWith("https://")) {
    return prioritize_base ? base_url : root_path;
  }
  return base_url + root_path;
}
async function get_jwt(space, token) {
  try {
    const r = await fetch(`https://huggingface.co/api/spaces/${space}/jwt`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    const jwt = (await r.json()).token;
    return jwt || false;
  } catch (e) {
    console.error(e);
    return false;
  }
}
function map_names_to_ids(fns) {
  let apis = {};
  fns.forEach(({ api_name }, i) => {
    if (api_name)
      apis[api_name] = i;
  });
  return apis;
}
async function resolve_config(endpoint) {
  const headers = this.options.hf_token ? { Authorization: `Bearer ${this.options.hf_token}` } : {};
  headers["Content-Type"] = "application/json";
  if (typeof window !== "undefined" && window.gradio_config && location.origin !== "http://localhost:9876" && !window.gradio_config.dev_mode) {
    const path = window.gradio_config.root;
    const config = window.gradio_config;
    let config_root = resolve_root(endpoint, config.root, false);
    config.root = config_root;
    return { ...config, path };
  } else if (endpoint) {
    const response = await this.fetch_implementation(
      `${endpoint}/${CONFIG_URL}`,
      {
        headers
      }
    );
    if ((response == null ? void 0 : response.status) === 200) {
      let config = await response.json();
      config.path = config.path ?? "";
      config.root = endpoint;
      return config;
    }
    throw new Error("Could not get config.");
  }
  throw new Error("No config or app endpoint found");
}
function determine_protocol(endpoint) {
  if (endpoint.startsWith("http")) {
    const { protocol, host } = new URL(endpoint);
    if (host.endsWith("hf.space")) {
      return {
        ws_protocol: "wss",
        host,
        http_protocol: protocol
      };
    }
    return {
      ws_protocol: protocol === "https:" ? "wss" : "ws",
      http_protocol: protocol,
      host
    };
  } else if (endpoint.startsWith("file:")) {
    return {
      ws_protocol: "ws",
      http_protocol: "http:",
      host: "lite.local"
      // Special fake hostname only used for this case. This matches the hostname allowed in `is_self_host()` in `js/wasm/network/host.ts`.
    };
  }
  return {
    ws_protocol: "wss",
    http_protocol: "https:",
    host: endpoint
  };
}
const RE_SPACE_NAME = /^[^\/]*\/[^\/]*$/;
const RE_SPACE_DOMAIN = /.*hf\.space\/{0,1}$/;
async function process_endpoint(app_reference, hf_token) {
  const headers = {};
  if (hf_token) {
    headers.Authorization = `Bearer ${hf_token}`;
  }
  const _app_reference = app_reference.trim();
  if (RE_SPACE_NAME.test(_app_reference)) {
    try {
      const res = await fetch(
        `https://huggingface.co/api/spaces/${_app_reference}/host`,
        { headers }
      );
      if (res.status !== 200)
        throw new Error("Space metadata could not be loaded.");
      const _host = (await res.json()).host;
      return {
        space_id: app_reference,
        ...determine_protocol(_host)
      };
    } catch (e) {
      throw new Error("Space metadata could not be loaded." + e.message);
    }
  }
  if (RE_SPACE_DOMAIN.test(_app_reference)) {
    const { ws_protocol, http_protocol, host } = determine_protocol(_app_reference);
    return {
      space_id: host.replace(".hf.space", ""),
      ws_protocol,
      http_protocol,
      host
    };
  }
  return {
    space_id: false,
    ...determine_protocol(_app_reference)
  };
}
function transform_api_info(api_info, config, api_map) {
  const transformed_info = {
    named_endpoints: {},
    unnamed_endpoints: {}
  };
  Object.keys(api_info).forEach((category) => {
    if (category === "named_endpoints" || category === "unnamed_endpoints") {
      transformed_info[category] = {};
      Object.entries(api_info[category]).forEach(
        ([endpoint, { parameters, returns }]) => {
          const dependencyIndex = config.dependencies.findIndex((dep) => dep.api_name === endpoint) || api_map[endpoint.replace("/", "")] || -1;
          const dependencyTypes = dependencyIndex !== -1 ? config.dependencies[dependencyIndex].types : { continuous: false, generator: false };
          const transform_type = (data, component, serializer, signature_type) => ({
            ...data,
            description: get_description(data.type, serializer),
            type: get_type(data.type, component, serializer, signature_type) || ""
          });
          transformed_info[category][endpoint] = {
            parameters: parameters.map(
              (p) => transform_type(p, p.component, p.serializer, "parameter")
            ),
            returns: returns.map(
              (r) => transform_type(r, r.component, r.serializer, "return")
            ),
            type: dependencyTypes
          };
        }
      );
    }
  });
  return transformed_info;
}
function get_type(type, component, serializer, signature_type) {
  switch (type.type) {
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "number":
      return "number";
  }
  if (serializer === "JSONSerializable" || serializer === "StringSerializable") {
    return "any";
  } else if (serializer === "ListStringSerializable") {
    return "string[]";
  } else if (component === "Image") {
    return signature_type === "parameter" ? "Blob | File | Buffer" : "string";
  } else if (serializer === "FileSerializable") {
    if ((type == null ? void 0 : type.type) === "array") {
      return signature_type === "parameter" ? "(Blob | File | Buffer)[]" : `{ name: string; data: string; size?: number; is_file?: boolean; orig_name?: string}[]`;
    }
    return signature_type === "parameter" ? "Blob | File | Buffer" : `{ name: string; data: string; size?: number; is_file?: boolean; orig_name?: string}`;
  } else if (serializer === "GallerySerializable") {
    return signature_type === "parameter" ? "[(Blob | File | Buffer), (string | null)][]" : `[{ name: string; data: string; size?: number; is_file?: boolean; orig_name?: string}, (string | null))][]`;
  }
}
function get_description(type, serializer) {
  if (serializer === "GallerySerializable") {
    return "array of [file, label] tuples";
  } else if (serializer === "ListStringSerializable") {
    return "array of strings";
  } else if (serializer === "FileSerializable") {
    return "array of files or single file";
  }
  return type.description;
}
function handle_message(data, last_status) {
  const queue = true;
  switch (data.msg) {
    case "send_data":
      return { type: "data" };
    case "send_hash":
      return { type: "hash" };
    case "queue_full":
      return {
        type: "update",
        status: {
          queue,
          message: QUEUE_FULL_MSG,
          stage: "error",
          code: data.code,
          success: data.success
        }
      };
    case "heartbeat":
      return {
        type: "heartbeat"
      };
    case "unexpected_error":
      return {
        type: "unexpected_error",
        status: {
          queue,
          message: data.message,
          stage: "error",
          success: false
        }
      };
    case "estimation":
      return {
        type: "update",
        status: {
          queue,
          stage: last_status || "pending",
          code: data.code,
          size: data.queue_size,
          position: data.rank,
          eta: data.rank_eta,
          success: data.success
        }
      };
    case "progress":
      return {
        type: "update",
        status: {
          queue,
          stage: "pending",
          code: data.code,
          progress_data: data.progress_data,
          success: data.success
        }
      };
    case "log":
      return { type: "log", data };
    case "process_generating":
      return {
        type: "generating",
        status: {
          queue,
          message: !data.success ? data.output.error : null,
          stage: data.success ? "generating" : "error",
          code: data.code,
          progress_data: data.progress_data,
          eta: data.average_duration
        },
        data: data.success ? data.output : null
      };
    case "process_completed":
      if ("error" in data.output) {
        return {
          type: "update",
          status: {
            queue,
            message: data.output.error,
            stage: "error",
            code: data.code,
            success: data.success
          }
        };
      }
      return {
        type: "complete",
        status: {
          queue,
          message: !data.success ? data.output.error : void 0,
          stage: data.success ? "complete" : "error",
          code: data.code,
          progress_data: data.progress_data
        },
        data: data.success ? data.output : null
      };
    case "process_starts":
      return {
        type: "update",
        status: {
          queue,
          stage: "pending",
          code: data.code,
          size: data.rank,
          position: 0,
          success: data.success,
          eta: data.eta
        }
      };
  }
  return { type: "none", status: { stage: "error", queue } };
}
async function view_api() {
  if (this.api_info)
    return this.api_info;
  const { hf_token } = this.options;
  const { config } = this;
  const headers = { "Content-Type": "application/json" };
  if (hf_token) {
    headers.Authorization = `Bearer ${hf_token}`;
  }
  if (!config) {
    return;
  }
  try {
    let response;
    if (semiver$1((config == null ? void 0 : config.version) || "2.0.0", "3.30") < 0) {
      response = await this.fetch_implementation(SPACE_FETCHER_URL, {
        method: "POST",
        body: JSON.stringify({
          serialize: false,
          config: JSON.stringify(config)
        }),
        headers
      });
    } else {
      response = await this.fetch_implementation(
        `${config == null ? void 0 : config.root}/${API_INFO_URL}`,
        {
          headers
        }
      );
    }
    if (!response.ok) {
      throw new Error(BROKEN_CONNECTION_MSG);
    }
    let api_info = await response.json();
    if ("api" in api_info) {
      api_info = api_info.api;
    }
    if (api_info.named_endpoints["/predict"] && !api_info.unnamed_endpoints["0"]) {
      api_info.unnamed_endpoints[0] = api_info.named_endpoints["/predict"];
    }
    return transform_api_info(api_info, config, this.api_map);
  } catch (e) {
    "Could not get API info. " + e.message;
  }
}
async function upload_files(root_url, files, upload_id) {
  const headers = {};
  if (this.options.hf_token) {
    headers.Authorization = `Bearer ${this.options.hf_token}`;
  }
  const chunkSize = 1e3;
  const uploadResponses = [];
  for (let i = 0; i < files.length; i += chunkSize) {
    const chunk = files.slice(i, i + chunkSize);
    const formData = new FormData();
    chunk.forEach((file) => {
      formData.append("files", file);
    });
    try {
      const upload_url = upload_id ? `${root_url}/upload?upload_id=${upload_id}` : `${root_url}/upload`;
      var response = await this.fetch_implementation(upload_url, {
        method: "POST",
        body: formData,
        headers
      });
    } catch (e) {
      return { error: BROKEN_CONNECTION_MSG };
    }
    if (!response.ok) {
      return { error: await response.text() };
    }
    const output = await response.json();
    if (output) {
      uploadResponses.push(...output);
    }
  }
  return { files: uploadResponses };
}
function update_object(object, newValue, stack) {
  while (stack.length > 1) {
    const key2 = stack.shift();
    if (typeof key2 === "string" || typeof key2 === "number") {
      object = object[key2];
    } else {
      throw new Error("Invalid key type");
    }
  }
  const key = stack.shift();
  if (typeof key === "string" || typeof key === "number") {
    object[key] = newValue;
  } else {
    throw new Error("Invalid key type");
  }
}
async function walk_and_store_blobs(param, type = void 0, path = [], root = false, endpoint_info = void 0) {
  if (Array.isArray(param)) {
    let blob_refs = [];
    await Promise.all(
      param.map(async (item) => {
        var _a;
        let new_path = path.slice();
        new_path.push(item);
        const array_refs = await walk_and_store_blobs(
          param[item],
          root ? ((_a = endpoint_info == null ? void 0 : endpoint_info.parameters[item]) == null ? void 0 : _a.component) || void 0 : type,
          new_path,
          false,
          endpoint_info
        );
        blob_refs = blob_refs.concat(array_refs);
      })
    );
    return blob_refs;
  } else if (globalThis.Buffer && param instanceof globalThis.Buffer) {
    const is_image = type === "Image";
    return [
      {
        path,
        blob: is_image ? false : new NodeBlob([param]),
        type
      }
    ];
  } else if (typeof param === "object") {
    let blob_refs = [];
    for (let key in param) {
      if (param.hasOwnProperty(key)) {
        let new_path = path.slice();
        new_path.push(key);
        blob_refs = blob_refs.concat(
          await walk_and_store_blobs(
            // @ts-ignore
            param[key],
            void 0,
            new_path,
            false,
            endpoint_info
          )
        );
      }
    }
    return blob_refs;
  }
  return [];
}
function skip_queue(id, config) {
  var _a, _b, _c, _d;
  return !(((_b = (_a = config == null ? void 0 : config.dependencies) == null ? void 0 : _a[id]) == null ? void 0 : _b.queue) === null ? config.enable_queue : (_d = (_c = config == null ? void 0 : config.dependencies) == null ? void 0 : _c[id]) == null ? void 0 : _d.queue) || false;
}
function post_message(message, origin) {
  return new Promise((res, _rej) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = ({ data }) => {
      channel.port1.close();
      res(data);
    };
    window.parent.postMessage(message, origin, [channel.port2]);
  });
}
async function upload(file_data, root_url, upload_id, max_file_size, upload_fn = upload_files) {
  let files = (Array.isArray(file_data) ? file_data : [file_data]).map(
    (file_data2) => file_data2.blob
  );
  const oversized_files = files.filter(
    (f) => f.size > (max_file_size ?? Infinity)
  );
  if (oversized_files.length) {
    throw new Error(
      `File size exceeds the maximum allowed size of ${max_file_size} bytes: ${oversized_files.map((f) => f.name).join(", ")}`
    );
  }
  return await Promise.all(
    await upload_fn(root_url, files, upload_id).then(
      async (response) => {
        if (response.error) {
          throw new Error(response.error);
        } else {
          if (response.files) {
            return response.files.map((f, i) => {
              const file = new FileData({
                ...file_data[i],
                path: f,
                url: root_url + "/file=" + f
              });
              return file;
            });
          }
          return [];
        }
      }
    )
  );
}
async function prepare_files(files, is_stream) {
  return files.map(
    (f) => new FileData({
      path: f.name,
      orig_name: f.name,
      blob: f,
      size: f.size,
      mime_type: f.type,
      is_stream
    })
  );
}
class FileData {
  constructor({
    path,
    url,
    orig_name,
    size,
    blob,
    is_stream,
    mime_type,
    alt_text
  }) {
    __publicField(this, "path");
    __publicField(this, "url");
    __publicField(this, "orig_name");
    __publicField(this, "size");
    __publicField(this, "blob");
    __publicField(this, "is_stream");
    __publicField(this, "mime_type");
    __publicField(this, "alt_text");
    __publicField(this, "meta", { _type: "gradio.FileData" });
    this.path = path;
    this.url = url;
    this.orig_name = orig_name;
    this.size = size;
    this.blob = url ? void 0 : blob;
    this.is_stream = is_stream;
    this.mime_type = mime_type;
    this.alt_text = alt_text;
  }
}
async function handle_blob(endpoint, data, api_info) {
  const self = this;
  const blobRefs = await walk_and_store_blobs(
    data,
    void 0,
    [],
    true,
    api_info
  );
  const results = await Promise.all(
    blobRefs.map(async ({ path, blob, type }) => {
      if (!blob)
        return { path, type };
      const response = await self.upload_files(endpoint, [blob]);
      const file_url = response.files && response.files[0];
      return {
        path,
        file_url,
        type,
        name: blob == null ? void 0 : blob.name
      };
    })
  );
  results.forEach(({ path, file_url, type, name }) => {
    if (type === "Gallery") {
      update_object(data, file_url, path);
    } else if (file_url) {
      const file = new FileData({ path: file_url, orig_name: name });
      update_object(data, file, path);
    }
  });
  return data;
}
async function post_data(url, body, additional_headers) {
  const headers = { "Content-Type": "application/json" };
  if (this.options.hf_token) {
    headers.Authorization = `Bearer ${this.options.hf_token}`;
  }
  try {
    var response = await this.fetch_implementation(url, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { ...headers, ...additional_headers }
    });
  } catch (e) {
    return [{ error: BROKEN_CONNECTION_MSG }, 500];
  }
  let output;
  let status;
  try {
    output = await response.json();
    status = response.status;
  } catch (e) {
    output = { error: `Could not parse server response: ${e}` };
    status = 500;
  }
  return [output, status];
}
async function predict(endpoint, data) {
  let data_returned = false;
  let status_complete = false;
  let dependency;
  if (!this.config) {
    throw new Error("Could not resolve app config");
  }
  if (typeof endpoint === "number") {
    dependency = this.config.dependencies[endpoint];
  } else {
    const trimmed_endpoint = endpoint.replace(/^\//, "");
    dependency = this.config.dependencies[this.api_map[trimmed_endpoint]];
  }
  if (dependency == null ? void 0 : dependency.types.continuous) {
    throw new Error(
      "Cannot call predict on this function as it may run forever. Use submit instead"
    );
  }
  return new Promise(async (resolve, reject) => {
    const app = this.submit(endpoint, data || []);
    let result;
    app.on("data", (d) => {
      if (status_complete) {
        app.destroy();
        resolve(d);
      }
      data_returned = true;
      result = d;
    }).on("status", (status) => {
      if (status.stage === "error")
        reject(status);
      if (status.stage === "complete") {
        status_complete = true;
        if (data_returned) {
          app.destroy();
          resolve(result);
        }
      }
    });
  });
}
async function check_space_status(id, type, status_callback) {
  let endpoint = type === "subdomain" ? `https://huggingface.co/api/spaces/by-subdomain/${id}` : `https://huggingface.co/api/spaces/${id}`;
  let response;
  let _status;
  try {
    response = await fetch(endpoint);
    _status = response.status;
    if (_status !== 200) {
      throw new Error();
    }
    response = await response.json();
  } catch (e) {
    status_callback({
      status: "error",
      load_status: "error",
      message: "Could not get space status",
      detail: "NOT_FOUND"
    });
    return;
  }
  if (!response || _status !== 200)
    return;
  const {
    runtime: { stage },
    id: space_name
  } = response;
  switch (stage) {
    case "STOPPED":
    case "SLEEPING":
      status_callback({
        status: "sleeping",
        load_status: "pending",
        message: "Space is asleep. Waking it up...",
        detail: stage
      });
      setTimeout(() => {
        check_space_status(id, type, status_callback);
      }, 1e3);
      break;
    case "PAUSED":
      status_callback({
        status: "paused",
        load_status: "error",
        message: "This space has been paused by the author. If you would like to try this demo, consider duplicating the space.",
        detail: stage,
        discussions_enabled: await discussions_enabled(space_name)
      });
      break;
    case "RUNNING":
    case "RUNNING_BUILDING":
      status_callback({
        status: "running",
        load_status: "complete",
        message: "",
        detail: stage
      });
      break;
    case "BUILDING":
      status_callback({
        status: "building",
        load_status: "pending",
        message: "Space is building...",
        detail: stage
      });
      setTimeout(() => {
        check_space_status(id, type, status_callback);
      }, 1e3);
      break;
    default:
      status_callback({
        status: "space_error",
        load_status: "error",
        message: "This space is experiencing an issue.",
        detail: stage,
        discussions_enabled: await discussions_enabled(space_name)
      });
      break;
  }
}
const RE_DISABLED_DISCUSSION = /^(?=[^]*\b[dD]iscussions{0,1}\b)(?=[^]*\b[dD]isabled\b)[^]*$/;
async function discussions_enabled(space_id) {
  try {
    const r = await fetch(
      `https://huggingface.co/api/spaces/${space_id}/discussions`,
      {
        method: "HEAD"
      }
    );
    const error = r.headers.get("x-error-message");
    if (error && RE_DISABLED_DISCUSSION.test(error))
      return false;
    return true;
  } catch (e) {
    return false;
  }
}
async function get_space_hardware(space_id, hf_token) {
  const headers = {};
  if (hf_token) {
    headers.Authorization = `Bearer ${hf_token}`;
  }
  try {
    const res = await fetch(
      `https://huggingface.co/api/spaces/${space_id}/runtime`,
      { headers }
    );
    if (res.status !== 200)
      throw new Error("Space hardware could not be obtained.");
    const { hardware } = await res.json();
    return hardware.current;
  } catch (e) {
    throw new Error(e.message);
  }
}
async function set_space_timeout(space_id, timeout, hf_token) {
  const headers = {};
  if (hf_token) {
    headers.Authorization = `Bearer ${hf_token}`;
  }
  const body = {
    seconds: timeout
  };
  try {
    const res = await fetch(
      `https://huggingface.co/api/spaces/${space_id}/sleeptime`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body)
      }
    );
    if (res.status !== 200) {
      throw new Error(
        "Could not set sleep timeout on duplicated Space. Please visit *ADD HF LINK TO SETTINGS* to set a timeout manually to reduce billing charges."
      );
    }
    const response = await res.json();
    return response;
  } catch (e) {
    throw new Error(e.message);
  }
}
const hardware_types = [
  "cpu-basic",
  "cpu-upgrade",
  "cpu-xl",
  "t4-small",
  "t4-medium",
  "a10g-small",
  "a10g-large",
  "a10g-largex2",
  "a10g-largex4",
  "a100-large",
  "zero-a10g",
  "h100",
  "h100x8"
];
async function duplicate(app_reference, options) {
  const { hf_token, private: _private, hardware, timeout } = options;
  if (hardware && !hardware_types.includes(hardware)) {
    throw new Error(
      `Invalid hardware type provided. Valid types are: ${hardware_types.map((v) => `"${v}"`).join(",")}.`
    );
  }
  const headers = {
    Authorization: `Bearer ${hf_token}`,
    "Content-Type": "application/json"
  };
  const user = (await (await fetch(`https://huggingface.co/api/whoami-v2`, {
    headers
  })).json()).name;
  const space_name = app_reference.split("/")[1];
  const body = {
    repository: `${user}/${space_name}`
  };
  if (_private) {
    body.private = true;
  }
  let original_hardware;
  if (!hardware) {
    original_hardware = await get_space_hardware(app_reference, hf_token);
  }
  const requested_hardware = hardware || original_hardware || "cpu-basic";
  body.hardware = requested_hardware;
  try {
    const response = await fetch(
      `https://huggingface.co/api/spaces/${app_reference}/duplicate`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      }
    );
    if (response.status === 409) {
      try {
        const client2 = await Client.connect(`${user}/${space_name}`, options);
        return client2;
      } catch (error) {
        console.error("Failed to connect Client instance:", error);
        throw error;
      }
    } else if (response.status !== 200) {
      throw new Error(response.statusText);
    }
    const duplicated_space = await response.json();
    await set_space_timeout(`${user}/${space_name}`, timeout || 300, hf_token);
    return await Client.connect(duplicated_space.url, options);
  } catch (e) {
    throw new Error(e);
  }
}
function open_stream() {
  let {
    event_callbacks,
    unclosed_events,
    pending_stream_messages,
    stream_status,
    config
  } = this;
  if (!config) {
    throw new Error("Could not resolve app config");
  }
  stream_status.open = true;
  let event_source = null;
  let params = new URLSearchParams({
    session_hash: this.session_hash
  }).toString();
  let url = new URL(`${config.root}/queue/data?${params}`);
  event_source = this.eventSource_factory(url);
  if (!event_source) {
    throw new Error("Cannot connect to sse endpoint: " + url.toString());
  }
  event_source.onmessage = async function(event) {
    let _data = JSON.parse(event.data);
    if (_data.msg === "close_stream") {
      close_stream(stream_status, event_source);
      return;
    }
    const event_id = _data.event_id;
    if (!event_id) {
      await Promise.all(
        Object.keys(event_callbacks).map(
          (event_id2) => (
            // @ts-ignore
            event_callbacks[event_id2](_data)
          )
          // todo: check event_callbacks
        )
      );
    } else if (event_callbacks[event_id] && config) {
      if (_data.msg === "process_completed" && ["sse", "sse_v1", "sse_v2", "sse_v2.1"].includes(config.protocol)) {
        unclosed_events.delete(event_id);
        if (unclosed_events.size === 0) {
          close_stream(stream_status, event_source);
        }
      }
      let fn2 = event_callbacks[event_id];
      window.setTimeout(fn2, 0, _data);
    } else {
      if (!pending_stream_messages[event_id]) {
        pending_stream_messages[event_id] = [];
      }
      pending_stream_messages[event_id].push(_data);
    }
  };
  event_source.onerror = async function() {
    await Promise.all(
      Object.keys(event_callbacks).map(
        (event_id) => (
          // @ts-ignore
          event_callbacks[event_id]({
            msg: "unexpected_error",
            message: BROKEN_CONNECTION_MSG
          })
        )
      )
    );
    close_stream(stream_status, event_source);
  };
}
function close_stream(stream_status, event_source) {
  if (stream_status && event_source) {
    stream_status.open = false;
    event_source == null ? void 0 : event_source.close();
  }
}
function apply_diff_stream(pending_diff_streams, event_id, data) {
  let is_first_generation = !pending_diff_streams[event_id];
  if (is_first_generation) {
    pending_diff_streams[event_id] = [];
    data.data.forEach((value, i) => {
      pending_diff_streams[event_id][i] = value;
    });
  } else {
    data.data.forEach((value, i) => {
      let new_data = apply_diff(pending_diff_streams[event_id][i], value);
      pending_diff_streams[event_id][i] = new_data;
      data.data[i] = new_data;
    });
  }
}
function apply_diff(obj, diff) {
  diff.forEach(([action, path, value]) => {
    obj = apply_edit(obj, path, action, value);
  });
  return obj;
}
function apply_edit(target, path, action, value) {
  if (path.length === 0) {
    if (action === "replace") {
      return value;
    } else if (action === "append") {
      return target + value;
    }
    throw new Error(`Unsupported action: ${action}`);
  }
  let current = target;
  for (let i = 0; i < path.length - 1; i++) {
    current = current[path[i]];
  }
  const last_path = path[path.length - 1];
  switch (action) {
    case "replace":
      current[last_path] = value;
      break;
    case "append":
      current[last_path] += value;
      break;
    case "add":
      if (Array.isArray(current)) {
        current.splice(Number(last_path), 0, value);
      } else {
        current[last_path] = value;
      }
      break;
    case "delete":
      if (Array.isArray(current)) {
        current.splice(Number(last_path), 1);
      } else {
        delete current[last_path];
      }
      break;
    default:
      throw new Error(`Unknown action: ${action}`);
  }
  return target;
}
function submit(endpoint, data, event_data, trigger_id) {
  try {
    let fire_event = function(event) {
      const narrowed_listener_map = listener_map;
      const listeners = narrowed_listener_map[event.type] || [];
      listeners == null ? void 0 : listeners.forEach((l) => l(event));
    }, on = function(eventType, listener) {
      const narrowed_listener_map = listener_map;
      const listeners = narrowed_listener_map[eventType] || [];
      narrowed_listener_map[eventType] = listeners;
      listeners == null ? void 0 : listeners.push(listener);
      return { on, off, cancel, destroy };
    }, off = function(eventType, listener) {
      const narrowed_listener_map = listener_map;
      let listeners = narrowed_listener_map[eventType] || [];
      listeners = listeners == null ? void 0 : listeners.filter((l) => l !== listener);
      narrowed_listener_map[eventType] = listeners;
      return { on, off, cancel, destroy };
    }, destroy = function() {
      var _a;
      for (const event_type in listener_map) {
        listener_map && ((_a = listener_map[event_type]) == null ? void 0 : _a.forEach((fn2) => {
          off(event_type, fn2);
        }));
      }
    };
    const { hf_token } = this.options;
    const {
      fetch_implementation,
      app_reference,
      config,
      session_hash,
      api_info,
      api_map,
      stream_status,
      pending_stream_messages,
      pending_diff_streams,
      event_callbacks,
      unclosed_events,
      post_data: post_data2
    } = this;
    if (!api_info)
      throw new Error("No API found");
    if (!config)
      throw new Error("Could not resolve app config");
    let { fn_index, endpoint_info, dependency } = get_endpoint_info(
      api_info,
      endpoint,
      api_map,
      config
    );
    let websocket;
    let event_source;
    let protocol = config.protocol ?? "ws";
    const _endpoint = typeof endpoint === "number" ? "/predict" : endpoint;
    let payload;
    let event_id = null;
    let complete = false;
    const listener_map = {};
    let last_status = {};
    let url_params = typeof window !== "undefined" ? new URLSearchParams(window.location.search).toString() : "";
    async function cancel() {
      const _status = {
        stage: "complete",
        queue: false,
        time: /* @__PURE__ */ new Date()
      };
      complete = _status;
      fire_event({
        ..._status,
        type: "status",
        endpoint: _endpoint,
        fn_index
      });
      let cancel_request = {};
      if (protocol === "ws") {
        if (websocket && websocket.readyState === 0) {
          websocket.addEventListener("open", () => {
            websocket.close();
          });
        } else {
          websocket.close();
        }
        cancel_request = { fn_index, session_hash };
      } else {
        event_source == null ? void 0 : event_source.close();
        cancel_request = { event_id };
      }
      try {
        if (!config) {
          throw new Error("Could not resolve app config");
        }
        await fetch_implementation(`${config.root}/reset`, {
          headers: { "Content-Type": "application/json" },
          method: "POST",
          body: JSON.stringify(cancel_request)
        });
      } catch (e) {
        console.warn(
          "The `/reset` endpoint could not be called. Subsequent endpoint results may be unreliable."
        );
      }
    }
    this.handle_blob(`${config.root}`, data, endpoint_info).then(
      async (_payload) => {
        payload = {
          data: _payload || [],
          event_data,
          fn_index,
          trigger_id
        };
        if (skip_queue(fn_index, config)) {
          fire_event({
            type: "status",
            endpoint: _endpoint,
            stage: "pending",
            queue: false,
            fn_index,
            time: /* @__PURE__ */ new Date()
          });
          post_data2(
            `${config.root}/run${_endpoint.startsWith("/") ? _endpoint : `/${_endpoint}`}${url_params ? "?" + url_params : ""}`,
            {
              ...payload,
              session_hash
            }
          ).then(([output, status_code]) => {
            const data2 = output.data;
            if (status_code == 200) {
              fire_event({
                type: "data",
                endpoint: _endpoint,
                fn_index,
                data: data2,
                time: /* @__PURE__ */ new Date(),
                event_data,
                trigger_id
              });
              fire_event({
                type: "status",
                endpoint: _endpoint,
                fn_index,
                stage: "complete",
                eta: output.average_duration,
                queue: false,
                time: /* @__PURE__ */ new Date()
              });
            } else {
              fire_event({
                type: "status",
                stage: "error",
                endpoint: _endpoint,
                fn_index,
                message: output.error,
                queue: false,
                time: /* @__PURE__ */ new Date()
              });
            }
          }).catch((e) => {
            fire_event({
              type: "status",
              stage: "error",
              message: e.message,
              endpoint: _endpoint,
              fn_index,
              queue: false,
              time: /* @__PURE__ */ new Date()
            });
          });
        } else if (protocol == "ws") {
          const { ws_protocol, host } = await process_endpoint(
            app_reference,
            hf_token
          );
          fire_event({
            type: "status",
            stage: "pending",
            queue: true,
            endpoint: _endpoint,
            fn_index,
            time: /* @__PURE__ */ new Date()
          });
          let url = new URL(
            `${ws_protocol}://${resolve_root(
              host,
              config.path,
              true
            )}/queue/join${url_params ? "?" + url_params : ""}`
          );
          if (this.jwt) {
            url.searchParams.set("__sign", this.jwt);
          }
          websocket = new WebSocket(url);
          websocket.onclose = (evt) => {
            if (!evt.wasClean) {
              fire_event({
                type: "status",
                stage: "error",
                broken: true,
                message: BROKEN_CONNECTION_MSG,
                queue: true,
                endpoint: _endpoint,
                fn_index,
                time: /* @__PURE__ */ new Date()
              });
            }
          };
          websocket.onmessage = function(event) {
            const _data = JSON.parse(event.data);
            const { type, status, data: data2 } = handle_message(
              _data,
              last_status[fn_index]
            );
            if (type === "update" && status && !complete) {
              fire_event({
                type: "status",
                endpoint: _endpoint,
                fn_index,
                time: /* @__PURE__ */ new Date(),
                ...status
              });
              if (status.stage === "error") {
                websocket.close();
              }
            } else if (type === "hash") {
              websocket.send(JSON.stringify({ fn_index, session_hash }));
              return;
            } else if (type === "data") {
              websocket.send(JSON.stringify({ ...payload, session_hash }));
            } else if (type === "complete") {
              complete = status;
            } else if (type === "log") {
              fire_event({
                type: "log",
                log: data2.log,
                level: data2.level,
                endpoint: _endpoint,
                fn_index
              });
            } else if (type === "generating") {
              fire_event({
                type: "status",
                time: /* @__PURE__ */ new Date(),
                ...status,
                stage: status == null ? void 0 : status.stage,
                queue: true,
                endpoint: _endpoint,
                fn_index
              });
            }
            if (data2) {
              fire_event({
                type: "data",
                time: /* @__PURE__ */ new Date(),
                data: data2.data,
                endpoint: _endpoint,
                fn_index,
                event_data,
                trigger_id
              });
              if (complete) {
                fire_event({
                  type: "status",
                  time: /* @__PURE__ */ new Date(),
                  ...complete,
                  stage: status == null ? void 0 : status.stage,
                  queue: true,
                  endpoint: _endpoint,
                  fn_index
                });
                websocket.close();
              }
            }
          };
          if (semiver(config.version || "2.0.0", "3.6") < 0) {
            addEventListener(
              "open",
              () => websocket.send(JSON.stringify({ hash: session_hash }))
            );
          }
        } else if (protocol == "sse") {
          fire_event({
            type: "status",
            stage: "pending",
            queue: true,
            endpoint: _endpoint,
            fn_index,
            time: /* @__PURE__ */ new Date()
          });
          var params = new URLSearchParams({
            fn_index: fn_index.toString(),
            session_hash
          }).toString();
          let url = new URL(
            `${config.root}/queue/join?${url_params ? url_params + "&" : ""}${params}`
          );
          event_source = this.eventSource_factory(url);
          if (!event_source) {
            throw new Error(
              "Cannot connect to sse endpoint: " + url.toString()
            );
          }
          event_source.onmessage = async function(event) {
            const _data = JSON.parse(event.data);
            const { type, status, data: data2 } = handle_message(
              _data,
              last_status[fn_index]
            );
            if (type === "update" && status && !complete) {
              fire_event({
                type: "status",
                endpoint: _endpoint,
                fn_index,
                time: /* @__PURE__ */ new Date(),
                ...status
              });
              if (status.stage === "error") {
                event_source == null ? void 0 : event_source.close();
              }
            } else if (type === "data") {
              event_id = _data.event_id;
              let [_, status2] = await post_data2(`${config.root}/queue/data`, {
                ...payload,
                session_hash,
                event_id
              });
              if (status2 !== 200) {
                fire_event({
                  type: "status",
                  stage: "error",
                  message: BROKEN_CONNECTION_MSG,
                  queue: true,
                  endpoint: _endpoint,
                  fn_index,
                  time: /* @__PURE__ */ new Date()
                });
                event_source == null ? void 0 : event_source.close();
              }
            } else if (type === "complete") {
              complete = status;
            } else if (type === "log") {
              fire_event({
                type: "log",
                log: data2.log,
                level: data2.level,
                endpoint: _endpoint,
                fn_index
              });
            } else if (type === "generating") {
              fire_event({
                type: "status",
                time: /* @__PURE__ */ new Date(),
                ...status,
                stage: status == null ? void 0 : status.stage,
                queue: true,
                endpoint: _endpoint,
                fn_index
              });
            }
            if (data2) {
              fire_event({
                type: "data",
                time: /* @__PURE__ */ new Date(),
                data: data2.data,
                endpoint: _endpoint,
                fn_index,
                event_data,
                trigger_id
              });
              if (complete) {
                fire_event({
                  type: "status",
                  time: /* @__PURE__ */ new Date(),
                  ...complete,
                  stage: status == null ? void 0 : status.stage,
                  queue: true,
                  endpoint: _endpoint,
                  fn_index
                });
                event_source == null ? void 0 : event_source.close();
              }
            }
          };
        } else if (protocol == "sse_v1" || protocol == "sse_v2" || protocol == "sse_v2.1" || protocol == "sse_v3") {
          fire_event({
            type: "status",
            stage: "pending",
            queue: true,
            endpoint: _endpoint,
            fn_index,
            time: /* @__PURE__ */ new Date()
          });
          let hostname = window.location.hostname;
          let hfhubdev = "dev.spaces.huggingface.tech";
          const origin = hostname.includes(".dev.") ? `https://moon-${hostname.split(".")[1]}.${hfhubdev}` : `https://huggingface.co`;
          const zerogpu_auth_promise = dependency.zerogpu && window.parent != window && config.space_id ? post_message("zerogpu-headers", origin) : Promise.resolve(null);
          const post_data_promise = zerogpu_auth_promise.then((headers) => {
            return post_data2(
              `${config.root}/queue/join?${url_params}`,
              {
                ...payload,
                session_hash
              },
              headers
            );
          });
          post_data_promise.then(([response, status]) => {
            if (status === 503) {
              fire_event({
                type: "status",
                stage: "error",
                message: QUEUE_FULL_MSG,
                queue: true,
                endpoint: _endpoint,
                fn_index,
                time: /* @__PURE__ */ new Date()
              });
            } else if (status !== 200) {
              fire_event({
                type: "status",
                stage: "error",
                message: BROKEN_CONNECTION_MSG,
                queue: true,
                endpoint: _endpoint,
                fn_index,
                time: /* @__PURE__ */ new Date()
              });
            } else {
              event_id = response.event_id;
              let callback = async function(_data) {
                try {
                  const { type, status: status2, data: data2 } = handle_message(
                    _data,
                    last_status[fn_index]
                  );
                  if (type == "heartbeat") {
                    return;
                  }
                  if (type === "update" && status2 && !complete) {
                    fire_event({
                      type: "status",
                      endpoint: _endpoint,
                      fn_index,
                      time: /* @__PURE__ */ new Date(),
                      ...status2
                    });
                  } else if (type === "complete") {
                    complete = status2;
                  } else if (type == "unexpected_error") {
                    console.error("Unexpected error", status2 == null ? void 0 : status2.message);
                    fire_event({
                      type: "status",
                      stage: "error",
                      message: (status2 == null ? void 0 : status2.message) || "An Unexpected Error Occurred!",
                      queue: true,
                      endpoint: _endpoint,
                      fn_index,
                      time: /* @__PURE__ */ new Date()
                    });
                  } else if (type === "log") {
                    fire_event({
                      type: "log",
                      log: data2.log,
                      level: data2.level,
                      endpoint: _endpoint,
                      fn_index
                    });
                    return;
                  } else if (type === "generating") {
                    fire_event({
                      type: "status",
                      time: /* @__PURE__ */ new Date(),
                      ...status2,
                      stage: status2 == null ? void 0 : status2.stage,
                      queue: true,
                      endpoint: _endpoint,
                      fn_index
                    });
                    if (data2 && ["sse_v2", "sse_v2.1", "sse_v3"].includes(protocol)) {
                      apply_diff_stream(pending_diff_streams, event_id, data2);
                    }
                  }
                  if (data2) {
                    fire_event({
                      type: "data",
                      time: /* @__PURE__ */ new Date(),
                      data: data2.data,
                      endpoint: _endpoint,
                      fn_index
                    });
                    if (complete) {
                      fire_event({
                        type: "status",
                        time: /* @__PURE__ */ new Date(),
                        ...complete,
                        stage: status2 == null ? void 0 : status2.stage,
                        queue: true,
                        endpoint: _endpoint,
                        fn_index
                      });
                    }
                  }
                  if ((status2 == null ? void 0 : status2.stage) === "complete" || (status2 == null ? void 0 : status2.stage) === "error") {
                    if (event_callbacks[event_id]) {
                      delete event_callbacks[event_id];
                    }
                    if (event_id in pending_diff_streams) {
                      delete pending_diff_streams[event_id];
                    }
                  }
                } catch (e) {
                  console.error("Unexpected client exception", e);
                  fire_event({
                    type: "status",
                    stage: "error",
                    message: "An Unexpected Error Occurred!",
                    queue: true,
                    endpoint: _endpoint,
                    fn_index,
                    time: /* @__PURE__ */ new Date()
                  });
                  if (["sse_v2", "sse_v2.1"].includes(protocol)) {
                    close_stream(stream_status, event_source);
                    stream_status.open = false;
                  }
                }
              };
              if (event_id in pending_stream_messages) {
                pending_stream_messages[event_id].forEach(
                  (msg) => callback(msg)
                );
                delete pending_stream_messages[event_id];
              }
              event_callbacks[event_id] = callback;
              unclosed_events.add(event_id);
              if (!stream_status.open) {
                this.open_stream();
              }
            }
          });
        }
      }
    );
    return { on, off, cancel, destroy };
  } catch (error) {
    console.error("Submit function encountered an error:", error);
    throw error;
  }
}
function get_endpoint_info(api_info, endpoint, api_map, config) {
  let fn_index;
  let endpoint_info;
  let dependency;
  if (typeof endpoint === "number") {
    fn_index = endpoint;
    endpoint_info = api_info.unnamed_endpoints[fn_index];
    dependency = config.dependencies[endpoint];
  } else {
    const trimmed_endpoint = endpoint.replace(/^\//, "");
    fn_index = api_map[trimmed_endpoint];
    endpoint_info = api_info.named_endpoints[endpoint.trim()];
    dependency = config.dependencies[api_map[trimmed_endpoint]];
  }
  if (typeof fn_index !== "number") {
    throw new Error(
      "There is no endpoint matching that name of fn_index matching that number."
    );
  }
  return { fn_index, endpoint_info, dependency };
}
class NodeBlob extends Blob {
  constructor(blobParts, options) {
    super(blobParts, options);
  }
}
class Client {
  constructor(app_reference, options = {}) {
    __publicField(this, "app_reference");
    __publicField(this, "options");
    __publicField(this, "config");
    __publicField(this, "api_info");
    __publicField(this, "api_map", {});
    __publicField(this, "session_hash", Math.random().toString(36).substring(2));
    __publicField(this, "jwt", false);
    __publicField(this, "last_status", {});
    // streaming
    __publicField(this, "stream_status", { open: false });
    __publicField(this, "pending_stream_messages", {});
    __publicField(this, "pending_diff_streams", {});
    __publicField(this, "event_callbacks", {});
    __publicField(this, "unclosed_events", /* @__PURE__ */ new Set());
    __publicField(this, "heartbeat_event", null);
    __publicField(this, "view_api");
    __publicField(this, "upload_files");
    __publicField(this, "handle_blob");
    __publicField(this, "post_data");
    __publicField(this, "submit");
    __publicField(this, "predict");
    __publicField(this, "open_stream");
    __publicField(this, "resolve_config");
    this.app_reference = app_reference;
    this.options = options;
    this.view_api = view_api.bind(this);
    this.upload_files = upload_files.bind(this);
    this.handle_blob = handle_blob.bind(this);
    this.post_data = post_data.bind(this);
    this.submit = submit.bind(this);
    this.predict = predict.bind(this);
    this.open_stream = open_stream.bind(this);
    this.resolve_config = resolve_config.bind(this);
  }
  fetch_implementation(input, init) {
    return fetch(input, init);
  }
  eventSource_factory(url) {
    if (typeof window !== void 0 && typeof EventSource !== "undefined") {
      return new EventSource(url.toString());
    }
    return null;
  }
  async init() {
    var _a;
    if ((typeof window === "undefined" || !("WebSocket" in window)) && !global.WebSocket) {
      const ws = await import("./wrapper-CviSselG.js");
      NodeBlob = (await import("node:buffer")).Blob;
      global.WebSocket = ws.WebSocket;
    }
    try {
      await this._resolve_config().then(async ({ config }) => {
        if (config) {
          this.config = config;
          if (this.config) {
            const heartbeat_url = new URL(
              `${this.config.root}/heartbeat/${this.session_hash}`
            );
            this.heartbeat_event = this.eventSource_factory(heartbeat_url);
            if (this.config.space_id && this.options.hf_token) {
              this.jwt = await get_jwt(
                this.config.space_id,
                this.options.hf_token
              );
            }
          }
        }
      });
    } catch (e) {
      throw Error(`Could not resolve config: ${e}`);
    }
    this.api_info = await this.view_api();
    this.api_map = map_names_to_ids(((_a = this.config) == null ? void 0 : _a.dependencies) || []);
  }
  static async connect(app_reference, options = {}) {
    const client2 = new this(app_reference, options);
    await client2.init();
    return client2;
  }
  close() {
    var _a;
    (_a = this.heartbeat_event) == null ? void 0 : _a.close();
  }
  static async duplicate(app_reference, options = {}) {
    return duplicate(app_reference, options);
  }
  async _resolve_config() {
    const { http_protocol, host, space_id } = await process_endpoint(
      this.app_reference,
      this.options.hf_token
    );
    const { status_callback } = this.options;
    let config;
    try {
      config = await this.resolve_config(`${http_protocol}//${host}`);
      if (!config) {
        throw new Error("Could not resolve app config");
      }
      return this.config_success(config);
    } catch (e) {
      console.error(e);
      if (space_id) {
        check_space_status(
          space_id,
          RE_SPACE_NAME.test(space_id) ? "space_name" : "subdomain",
          this.handle_space_success
        );
      } else {
        if (status_callback)
          status_callback({
            status: "error",
            message: "Could not load this space.",
            load_status: "error",
            detail: "NOT_FOUND"
          });
      }
    }
  }
  async config_success(_config) {
    this.config = _config;
    if (typeof window !== "undefined") {
      if (window.location.protocol === "https:") {
        this.config.root = this.config.root.replace("http://", "https://");
      }
    }
    if (this.config.auth_required) {
      return this.prepare_return_obj();
    }
    try {
      this.api_info = await this.view_api();
    } catch (e) {
      console.error(`Could not get API details: ${e.message}`);
    }
    return this.prepare_return_obj();
  }
  async handle_space_success(status) {
    const { status_callback } = this.options;
    if (status_callback)
      status_callback(status);
    if (status.status === "running") {
      try {
        this.config = await this._resolve_config();
        if (!this.config) {
          throw new Error("Could not resolve app config");
        }
        const _config = await this.config_success(this.config);
        return _config;
      } catch (e) {
        console.error(e);
        if (status_callback) {
          status_callback({
            status: "error",
            message: "Could not load this space.",
            load_status: "error",
            detail: "NOT_FOUND"
          });
        }
      }
    }
  }
  async component_server(component_id, fn_name, data) {
    var _a;
    if (!this.config) {
      throw new Error("Could not resolve app config");
    }
    const headers = {};
    const { hf_token } = this.options;
    const { session_hash } = this;
    if (hf_token) {
      headers.Authorization = `Bearer ${this.options.hf_token}`;
    }
    let root_url;
    let component = this.config.components.find(
      (comp) => comp.id === component_id
    );
    if ((_a = component == null ? void 0 : component.props) == null ? void 0 : _a.root_url) {
      root_url = component.props.root_url;
    } else {
      root_url = this.config.root;
    }
    let body;
    if ("binary" in data) {
      body = new FormData();
      for (const key in data.data) {
        if (key === "binary")
          continue;
        body.append(key, data.data[key]);
      }
      body.set("component_id", component_id.toString());
      body.set("fn_name", fn_name);
      body.set("session_hash", session_hash);
    } else {
      body = JSON.stringify({
        data,
        component_id,
        fn_name,
        session_hash
      });
      headers["Content-Type"] = "application/json";
    }
    if (hf_token) {
      headers.Authorization = `Bearer ${hf_token}`;
    }
    try {
      const response = await this.fetch_implementation(
        `${root_url}/component_server/`,
        {
          method: "POST",
          body,
          headers
        }
      );
      if (!response.ok) {
        throw new Error(
          "Could not connect to component server: " + response.statusText
        );
      }
      const output = await response.json();
      return output;
    } catch (e) {
      console.warn(e);
    }
  }
  prepare_return_obj() {
    return {
      config: this.config,
      predict: this.predict,
      submit: this.submit,
      view_api: this.view_api,
      component_server: this.component_server
    };
  }
}
async function client(app_reference, options = {}) {
  return await Client.connect(app_reference, options);
}
export {
  Client,
  FileData,
  client,
  duplicate,
  predict,
  prepare_files,
  submit,
  upload,
  upload_files
};
