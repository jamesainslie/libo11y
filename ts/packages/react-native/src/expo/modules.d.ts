/**
 * The slices of the Expo SDK 58 modules expo.ts uses, declared here so the workspace does not
 * install Expo. The fixture app (ts/fixtures/expo-app/src/shapes.ts) typechecks the structural
 * contracts against the real modules, so a change in Expo fails there.
 */

declare module "expo-file-system" {
  export class Directory {
    constructor(...uris: (string | File | Directory)[]);
    readonly exists: boolean;
    create(options?: { readonly intermediates?: boolean; readonly idempotent?: boolean }): void;
    list(): (Directory | File)[];
  }
  export class File {
    constructor(...uris: (string | File | Directory)[]);
    readonly exists: boolean;
    readonly name: string;
    text(): Promise<string>;
    write(content: string): Promise<void>;
    delete(): void;
    move(destination: File | Directory, options?: { readonly overwrite?: boolean }): Promise<void>;
  }
  export const Paths: { readonly document: Directory };
}

declare module "expo-application" {
  export const nativeApplicationVersion: string | null;
}

declare module "expo-device" {
  /** A DeviceType enum value: 0 unknown, 1 phone, 2 tablet, 3 desktop, 4 TV. */
  export const deviceType: number | null;
}

declare module "expo-updates" {
  export const isEnabled: boolean;
  export const isEmbeddedLaunch: boolean;
  export const updateId: string | null;
}
