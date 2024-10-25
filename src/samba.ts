import SambaClient from "samba-client";
import { BackupService, fileExtension, findFilesToRemove } from "./types";

interface ISambaClientOptions {
    readonly address: string;
    readonly username?: string;
    readonly password?: string;
    readonly domain?: string;
    readonly port?: number;
    readonly directory?: string;
    readonly timeout?: number;
    readonly maxProtocol?: string;
    readonly maskCmd?: boolean;
}

export class Samba extends SambaClient implements BackupService {
    constructor(props: ISambaClientOptions, public console: Console) {
        if (!props.address) {
            throw new Error('Address is required');
        }

        super(props);
    }

    log(message?: any, ...optionalParams: any[]) {
        this.console.log(`[SAMBA] `, message, ...optionalParams);
    }

    downloadBackup(props: { filePrefix: string }): Promise<Buffer> {
        throw new Error("Method not implemented.");
    }

    async uploadBackup(props: { fileName: string; filePath: string; }) {
        const { fileName, filePath } = props;
        const dst = fileName;
        this.log(`Uploading file to SMB. Source path is ${filePath}, destination is ${dst}`);
        try {
            await this.sendFile(filePath, dst);
        } catch (e) {
            this.log('Error uploading backup to SMB', e);
        }
    }

    async pruneOldBackups(props: { maxBackups: number; filePrefix: string }) {
        const { filePrefix, maxBackups } = props;

        const allFiles = await this.listFiles(filePrefix, fileExtension);

        const filesToRemove = findFilesToRemove({ fileNames: allFiles, filesToKeep: maxBackups, filePrefix });
        const filesCountToRemove = filesToRemove.length;

        if (filesCountToRemove > 0) {
            for (const fileName of filesToRemove) {
                try {
                    await this.deleteFile(fileName);
                    this.log(`File ${fileName} removed`);
                } catch (e) {
                    this.log(`Error removing file ${fileName}`, e);
                }
            }
        }

        return filesCountToRemove;
    }
}