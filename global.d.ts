declare module '*?raw' {
  const content: string;
  export default content;
}
declare module '*?url' {
  const content: string;
  export default content;
}
declare module '*.css' {
  const content: unknown;
  export default content;
}
declare module '*.html' {
  const content: string;
  export default content;
}
declare module '*.md' {
  const content: string;
  export default content;
}
declare module '*.yaml' {
  const content: any;
  export default content;
}
declare module '*.vue' {
  import { DefineComponent } from 'vue';
  const component: DefineComponent;
  export default component;
}

type BluetoothLEScanFilter = object;
type BluetoothServiceUUID = string | number;
type BluetoothDevice = object;
type BluetoothRemoteGATTServer = object;

declare module 'sillytavern/extensions' {
  export const extension_settings: Record<string, any>;
}

declare module 'sillytavern/script' {
  export const eventSource: any;
  export const event_types: Record<string, string>;
  export function saveSettingsDebounced(): void;
}

declare module 'sillytavern/power-user' {
  export const power_user: any;
}

declare module 'sillytavern/popup' {
  export const POPUP_TYPE: Record<string, any>;
  export class Popup {
    constructor(...args: any[]);
    show(): void;
  }
}

declare const YAML: typeof import('yaml');

declare const z: typeof import('zod');
declare namespace z {
  export type infer<T> = import('zod').infer<T>;
  export type input<T> = import('zod').input<T>;
  export type output<T> = import('zod').output<T>;
}

declare module 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js' {
  export function registerMvuSchema(
    schema: z.ZodType<Record<string, any>> | (() => z.ZodType<Record<string, any>>),
  ): void;
}
