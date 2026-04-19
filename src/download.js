/**
 * Save a PNG blob: prefers the File System Access API when available, otherwise <a download>.
 */
function fallbackDownload(blob, fileName) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

window.saveTantalumPng = function (blob, fileName) {
    if (!blob) {
        return;
    }
    if (typeof window.showSaveFilePicker === "function") {
        window
            .showSaveFilePicker({
                suggestedName: fileName,
                types: [{ description: "PNG", accept: { "image/png": [".png"] } }],
            })
            .then(function (handle) {
                return handle.createWritable();
            })
            .then(function (writable) {
                return writable.write(blob).then(function () {
                    return writable.close();
                });
            })
            .catch(function (err) {
                if (err && err.name === "AbortError") {
                    return;
                }
                fallbackDownload(blob, fileName);
            });
        return;
    }
    fallbackDownload(blob, fileName);
};
