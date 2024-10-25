import orderBy from "lodash/orderBy";

export interface DownloadedFile {

}

export interface BackupService {
    console: Console;

    downloadBackup(props: { filePrefix: string }): Promise<Buffer>;
    uploadBackup(props: { fileName: string, filePath: string }): Promise<void>;
    pruneOldBackups(props: { maxBackups: number, filePrefix: string }): Promise<number>;
}

export enum BackupServiceEnum {
    Samba = 'Samba'
}

export const fileExtension = '.zip';

export const findFilesToRemove = (props: { fileNames: string[], filesToKeep: number, filePrefix: string }) => {
    const { fileNames, filePrefix, filesToKeep } = props;
    const fileDateMap: Record<string, number> = {};

    for (const fileName of fileNames) {
        const fileDate = fileName.split(filePrefix)[1].replace(fileExtension, '').replace('-', '');
        const [year, month, day, hour, minute, second] = fileDate.split('_');
        const date = new Date();

        date.setFullYear(Number(year));
        date.setMonth(Number(month));
        date.setDate(Number(day));
        date.setHours(Number(hour));
        date.setMinutes(Number(minute));
        date.setSeconds(Number(second));
        date.setMilliseconds(0);

        fileDateMap[fileName] = date.getTime();
    }

    const filesOrderedByDate = orderBy(fileNames, fileName => fileDateMap[fileName], 'asc');
    const filesCountToRemove = filesOrderedByDate.length - filesToKeep;
    const filesToRemove = filesOrderedByDate.splice(0, filesCountToRemove);

    return filesToRemove;
}