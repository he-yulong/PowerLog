import { useEffect, useState } from 'react';

const TrainingEntriesList = ({ refresh }) => {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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

  if (loading) {
    return <div className="loading">Loading entries...</div>;
  }

  if (error) {
    return <div className="error-message">Error: {error}</div>;
  }

  return (
    <div className="training-entries-list">
      <h2>Training Log</h2>
      {entries.length === 0 ? (
        <p className="no-entries">No training entries yet. Add your first entry above!</p>
      ) : (
        <div className="entries-container">
          {entries.map((entry) => (
            <div key={entry.id} className="entry-card">
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default TrainingEntriesList;
