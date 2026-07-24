"""Entity mapping for the dataset_file table."""


def dataset_file_to_api(row: dict) -> dict:
    """Map one `dataset_file` DB row (snake_case) to the API's camelCase shape."""
    return {
        "id": row["id"],
        "datasetId": row["dataset_id"],
        "fileName": row["file_name"],
        "filePath": row["file_path"],
        "fileType": row["file_type"],
        "fileSize": row["file_size"],
        "createdTime": row["created_time"].isoformat() if row["created_time"] else None,
    }
