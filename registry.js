import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import { PrefsFields } from './constants.js';

const FileCopyFlags = Gio.FileCopyFlags;
const FileTest = GLib.FileTest;

async function mapWithConcurrency (values, concurrency, transform) {
    const results = new Array(values.length);
    let nextIndex = 0;

    const workers = Array.from(
        { length: Math.min(concurrency, values.length) },
        async () => {
            while (nextIndex < values.length) {
                const index = nextIndex++;
                results[index] = await transform(values[index], index);
            }
        }
    );

    await Promise.all(workers);
    return results;
}

export class Registry {
    #entryFileWrites = new Map();
    #entryFileDeletes = new Map();

    constructor ({ settings, uuid }) {
        this.uuid = uuid;
        this.settings = settings;
        this.REGISTRY_FILE = 'registry.txt';
        this.REGISTRY_DIR = GLib.get_user_cache_dir() + '/' + this.uuid;
        this.REGISTRY_PATH = this.REGISTRY_DIR + '/' + this.REGISTRY_FILE;
        this.BACKUP_REGISTRY_PATH = this.REGISTRY_PATH + '~';
    }

    write (entries) {
        const registryContent = [];

        for (let entry of entries) {
            const item = {
                favorite: entry.isFavorite(),
                mimetype: entry.mimetype()
            };

            registryContent.push(item);

            if (entry.isText()) {
                item.contents = entry.getStringValue();
            }
            else if (entry.isImage()) {
                const filename = this.getEntryFilename(entry);
                item.contents = filename;
                this.writeEntryFile(entry).catch(error => {
                    console.error('Clipboard Indicator: failed to cache image');
                    console.error(error);
                });
            }
        }

        this.writeToFile(registryContent);
    }

    writeToFile (registry) {
        let json = JSON.stringify(registry);
        let contents = new GLib.Bytes(json);

        // Make sure dir exists
        GLib.mkdir_with_parents(this.REGISTRY_DIR, parseInt('0775', 8));

        // Write contents to file asynchronously
        let file = Gio.file_new_for_path(this.REGISTRY_PATH);
        file.replace_async(null, false, Gio.FileCreateFlags.NONE,
                            GLib.PRIORITY_DEFAULT, null, (obj, res) => {

            let stream = obj.replace_finish(res);

            stream.write_bytes_async(contents, GLib.PRIORITY_DEFAULT,
                                null, (w_obj, w_res) => {

                w_obj.write_bytes_finish(w_res);
                stream.close(null);
            });
        });
    }

    async read () {
        if (!GLib.file_test(this.REGISTRY_PATH, FileTest.EXISTS))
            return [];

        try {
            const file = Gio.file_new_for_path(this.REGISTRY_PATH);
            const fileInfo = await new Promise((resolve, reject) => {
                file.query_info_async('*', Gio.FileQueryInfoFlags.NONE,
                    GLib.PRIORITY_DEFAULT, null, (src, res) => {
                        try {
                            resolve(src.query_info_finish(res));
                        } catch (error) {
                            reject(error);
                        }
                    }
                );
            });

            const cacheFileSize = this.settings.get_int(PrefsFields.CACHE_FILE_SIZE);
            if (fileInfo.get_size() >= cacheFileSize * 1024 * 1024) {
                const destination = Gio.file_new_for_path(this.BACKUP_REGISTRY_PATH);
                file.move(destination, FileCopyFlags.OVERWRITE, null, null);
                return [];
            }

            const [success, contents] = await new Promise((resolve, reject) => {
                file.load_contents_async(null, (obj, res) => {
                    try {
                        resolve(obj.load_contents_finish(res));
                    } catch (error) {
                        reject(error);
                    }
                });
            });

            if (!success) {
                console.error('Clipboard Indicator: failed to open registry file');
                return [];
            }

            const cacheTextData = new TextDecoder().decode(contents);
            const registry = cacheTextData.trim() ? JSON.parse(cacheTextData) : [];
            if (!Array.isArray(registry))
                return [];

            // Discard old history before opening image files. Pinned entries are kept.
            const maxSize = this.settings.get_int(PrefsFields.HISTORY_SIZE);
            const nonFavoriteCount = registry.reduce(
                (count, entry) => count + (entry.favorite ? 0 : 1), 0
            );
            let entriesToSkip = Math.max(0, nonFavoriteCount - maxSize);
            const retainedRegistry = registry.filter(entry => {
                if (entry.favorite)
                    return true;
                if (entriesToSkip > 0) {
                    entriesToSkip--;
                    return false;
                }
                return true;
            });

            const clipboardEntries = await mapWithConcurrency(
                retainedRegistry,
                8,
                async jsonEntry => {
                    try {
                        return await ClipboardEntry.fromJSON(jsonEntry);
                    } catch (error) {
                        console.error('Clipboard Indicator: failed to load cached entry');
                        console.error(error);
                        return null;
                    }
                }
            );

            return clipboardEntries.filter(entry => entry !== null);
        } catch (error) {
            console.error('Clipboard Indicator: failed to read registry');
            console.error(error);
            return [];
        }
    }

    async getEntryAsImage (entry) {
        if (entry.isImage() === false) return;

        await this.writeEntryFile(entry);

        const gicon = Gio.icon_new_for_string(this.getEntryFilename(entry));
        const stIcon = new St.Icon({ gicon });
        return stIcon;
    }

    getEntryFilename (entry) {
        return `${this.REGISTRY_DIR}/${entry.imageId()}`;
    }

    async writeEntryFile (entry) {
        const filename = this.getEntryFilename(entry);
        const pendingDelete = this.#entryFileDeletes.get(filename);
        if (pendingDelete)
            await pendingDelete;

        if (GLib.file_test(filename, FileTest.EXISTS))
            return;

        const pendingWrite = this.#entryFileWrites.get(filename);
        if (pendingWrite)
            return pendingWrite;

        GLib.mkdir_with_parents(this.REGISTRY_DIR, parseInt('0775', 8));
        const file = Gio.file_new_for_path(filename);
        const writePromise = new Promise((resolve, reject) => {
            file.replace_async(null, false, Gio.FileCreateFlags.NONE,
                GLib.PRIORITY_DEFAULT, null, (obj, res) => {
                    let stream;
                    try {
                        stream = obj.replace_finish(res);
                    } catch (error) {
                        reject(error);
                        return;
                    }

                    stream.write_bytes_async(entry.asBytes(), GLib.PRIORITY_DEFAULT,
                        null, (writeObject, writeResult) => {
                            try {
                                writeObject.write_bytes_finish(writeResult);
                                stream.close(null);
                                resolve();
                            } catch (error) {
                                stream.close(null);
                                reject(error);
                            }
                        }
                    );
                }
            );
        });

        this.#entryFileWrites.set(filename, writePromise);
        try {
            await writePromise;
        } finally {
            this.#entryFileWrites.delete(filename);
        }
    }

    async deleteEntryFile (entry) {
        const filename = this.getEntryFilename(entry);
        const pendingDelete = this.#entryFileDeletes.get(filename);
        if (pendingDelete)
            return pendingDelete;

        const pendingWrite = this.#entryFileWrites.get(filename);
        if (pendingWrite) {
            try {
                await pendingWrite;
            } catch (error) {
                // The file may not exist if its write failed.
            }
        }

        const existingDelete = this.#entryFileDeletes.get(filename);
        if (existingDelete)
            return existingDelete;

        const file = Gio.file_new_for_path(filename);
        const deletePromise = (async () => {
            try {
                await file.delete_async(GLib.PRIORITY_DEFAULT, null);
            } catch (error) {
                console.error(error);
            }
        })();
        this.#entryFileDeletes.set(filename, deletePromise);

        try {
            await deletePromise;
        }
        finally {
            this.#entryFileDeletes.delete(filename);
        }
    }

}

export class ClipboardEntry {
    #mimetype;
    #bytes;
    #favorite;
    #imageId = null;
    #fingerprint = null;
    #stringValue = null;

    static #decode (contents) {
        return Uint8Array.from(contents.match(/.{1,2}/g).map((byte) => parseInt(byte, 16)));
    }

    static __isText (mimetype) {
        return mimetype.startsWith('text/') ||
            mimetype === 'STRING' ||
            mimetype === 'UTF8_STRING';
    }

    static async fromJSON (jsonEntry) {
        const mimetype = jsonEntry.mimetype || 'text/plain;charset=utf-8';
        const favorite = jsonEntry.favorite;
        let bytes;
        let imageId = null;

        if (ClipboardEntry.__isText(mimetype)) {
            bytes = new TextEncoder().encode(jsonEntry.contents);
        }
        else if (mimetype.startsWith('image/')) {
            const filename = jsonEntry.contents;
            if (!filename || !GLib.file_test(filename, FileTest.EXISTS)) return null;

            const file = Gio.file_new_for_path(filename);
            const [success, contents] = await new Promise((resolve, reject) => {
                file.load_contents_async(null, (obj, res) => {
                    try {
                        resolve(obj.load_contents_finish(res));
                    } catch (error) {
                        reject(error);
                    }
                });
            });
            if (!success)
                throw new Error('Clipboard Indicator: could not read image file from cache');

            bytes = contents;
            imageId = file.get_basename();
        } else {
            return null;
        }

        return new ClipboardEntry(mimetype, bytes, favorite, imageId);
    }

    constructor (mimetype, bytes, favorite, imageId = null) {
        this.#mimetype = mimetype;
        this.#bytes = bytes;
        this.#favorite = favorite;
        if (this.isImage()) {
            this.#imageId = imageId ?? GLib.uuid_string_random();
            this.#fingerprint = this.#computeFingerprint();
        }
    }

    #encode () {
        if (this.isText()) {
            return this.getStringValue();
        }

        return [...this.#bytes]
            .map(x => x.toString(16).padStart(2, '0'))
            .join('');
    }

    getStringValue () {
        if (this.isImage()) {
            return `[Image ${this.imageFingerprint()}]`;
        }
        if (this.#stringValue === null)
            this.#stringValue = new TextDecoder().decode(this.#bytes);
        return this.#stringValue;
    }

    #computeFingerprint () {
        // Sample at most 4096 bytes; equals() confirms matches against the full image.
        let fingerprint = 2166136261;
        const sampleStep = Math.max(1, Math.ceil(this.#bytes.length / 4096));

        for (let index = 0; index < this.#bytes.length; index += sampleStep) {
            fingerprint ^= this.#bytes[index];
            fingerprint = Math.imul(fingerprint, 16777619);
        }

        fingerprint ^= this.#bytes.length;
        fingerprint = Math.imul(fingerprint, 16777619);
        return `${this.#bytes.length}:${(fingerprint >>> 0).toString(16)}`;
    }

    imageFingerprint () {
        return this.#fingerprint;
    }

    imageId () {
        return this.#imageId;
    }

    mimetype () {
        return this.#mimetype;
    }

    isFavorite () {
        return this.#favorite;
    }

    set favorite (val) {
        this.#favorite = !!val;
    }

    isText () {
        return ClipboardEntry.__isText(this.#mimetype);
    }

    isImage () {
        return this.#mimetype.startsWith('image/');
    }

    asBytes () {
        return GLib.Bytes.new(this.#bytes);
    }

    equals (otherEntry) {
        if (this.isImage() || otherEntry.isImage()) {
            return this.isImage() && otherEntry.isImage() &&
                this.imageFingerprint() === otherEntry.imageFingerprint() &&
                this.asBytes().equal(otherEntry.asBytes());
        }
        return this.getStringValue() === otherEntry.getStringValue();
    }
}
