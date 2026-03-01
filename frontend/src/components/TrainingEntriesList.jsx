import { useEffect, useState } from 'react';

const TrainingEntriesList = ({ refresh }) => {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editFormData, setEditFormData] = useState({});

  const fetchEntries = async () => {
    try {
      setLoading(true);
      const response = await fetch('http://localhost:8000/api/training/entries/');
      if (!response.ok) {
        throw new Error('Failed to fetch entries');
      }
      const data = await response.json();
      setEntries(data);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEntries();
  }, [refresh]);

  const formatDate = (dateString) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  };

  const handleEdit = (entry) => {
    setEditingId(entry.id);
    setEditFormData({
      date: entry.date,
      exercise_type: entry.exercise_type,
      exercise_name: entry.exercise_name,
      weight: entry.weight,
      sets: entry.sets,
      reps: entry.reps,
      rpe: entry.rpe || '',
      notes: entry.notes || ''
    });
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditFormData({});
  };

  const handleEditChange = (e) => {
    const { name, value } = e.target;
    setEditFormData({ ...editFormData, [name]: value });
  };

  const handleSaveEdit = async (id) => {
    try {
      const payload = {
        date: editFormData.date,
        exercise_type: editFormData.exercise_type,
        exercise_name: editFormData.exercise_name,
        weight: parseFloat(editFormData.weight),
        sets: parseInt(editFormData.sets),
        reps: parseInt(editFormData.reps),
        rpe: editFormData.rpe ? parseFloat(editFormData.rpe) : null,
        notes: editFormData.notes || null
      };

      const response = await fetch(`http://localhost:8000/api/training/entries/${id}/`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error('Failed to update entry');
      }

      await fetchEntries();
      setEditingId(null);
      setEditFormData({});
    } catch (err) {
      setError(`Failed to update: ${err.message}`);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Are you sure you want to delete this entry?')) {
      return;
    }

    try {
      const response = await fetch(`http://localhost:8000/api/training/entries/${id}/`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Failed to delete entry');
      }

      await fetchEntries();
    } catch (err) {
      setError(`Failed to delete: ${err.message}`);
    }
  };

  if (loading) {
    return <div className="loading">Loading entries...</div>;
  }

  if (error) {
    return <div className="error-message">Error: {error}</div>;
  }

  return (
    <div className="training-entries-list">
      <h2>Training Log</h2>
      {error && <div className="error-message">{error}</div>}
      {entries.length === 0 ? (
        <p className="no-entries">No training entries yet. Add your first entry above!</p>
      ) : (
        <div className="entries-container">
          {entries.map((entry) => (
            <div key={entry.id} className="entry-card">
              {editingId === entry.id ? (
                // Edit mode
                <div className="edit-form">
                  <div className="form-row">
                    <label>Date:</label>
                    <input
                      type="date"
                      name="date"
                      value={editFormData.date}
                      onChange={handleEditChange}
                    />
                  </div>
                  <div className="form-row">
                    <label>Exercise:</label>
                    <input
                      type="text"
                      name="exercise_name"
                      value={editFormData.exercise_name}
                      onChange={handleEditChange}
                    />
                  </div>
                  <div className="form-row">
                    <label>Weight (kg):</label>
                    <input
                      type="number"
                      name="weight"
                      value={editFormData.weight}
                      onChange={handleEditChange}
                      step="0.01"
                      min="0"
                    />
                  </div>
                  <div className="form-row">
                    <label>Sets:</label>
                    <input
                      type="number"
                      name="sets"
                      value={editFormData.sets}
                      onChange={handleEditChange}
                      min="1"
                    />
                  </div>
                  <div className="form-row">
                    <label>Reps:</label>
                    <input
                      type="number"
                      name="reps"
                      value={editFormData.reps}
                      onChange={handleEditChange}
                      min="1"
                    />
                  </div>
                  <div className="form-row">
                    <label>RPE:</label>
                    <input
                      type="number"
                      name="rpe"
                      value={editFormData.rpe}
                      onChange={handleEditChange}
                      step="0.5"
                      min="0"
                      max="10"
                    />
                  </div>
                  <div className="form-row">
                    <label>Notes:</label>
                    <textarea
                      name="notes"
                      value={editFormData.notes}
                      onChange={handleEditChange}
                      rows="2"
                    />
                  </div>
                  <div className="edit-actions">
                    <button onClick={() => handleSaveEdit(entry.id)} className="save-button">
                      Save
                    </button>
                    <button onClick={handleCancelEdit} className="cancel-button">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                // View mode
                <>
                  <div className="entry-header">
                    <h3>{entry.exercise_name}</h3>
                    <span className="entry-date">{formatDate(entry.date)}</span>
                  </div>
                  <div className="entry-details">
                    <div className="entry-stats">
                      <span className="stat">
                        <strong>Weight:</strong> {entry.weight} kg
                      </span>
                      <span className="stat">
                        <strong>Sets:</strong> {entry.sets}
                      </span>
                      <span className="stat">
                        <strong>Reps:</strong> {entry.reps}
                      </span>
                      {entry.rpe && (
                        <span className="stat">
                          <strong>RPE:</strong> {entry.rpe}
                        </span>
                      )}
                    </div>
                    {entry.notes && (
                      <div className="entry-notes">
                        <strong>Notes:</strong> {entry.notes}
                      </div>
                    )}
                  </div>
                  <div className="entry-actions">
                    <button onClick={() => handleEdit(entry)} className="edit-button">
                      Edit
                    </button>
                    <button onClick={() => handleDelete(entry.id)} className="delete-button">
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default TrainingEntriesList;
